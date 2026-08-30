import type {
  RoundtripFieldCandidate,
  RoundtripFieldCoverageIssue,
  RoundtripFieldCoverageSummary,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";

const COLLAPSED_CONTEXT_LENGTH = 400;
const GENERIC_CHOICE_COLLAPSED_LENGTH = 120;
const GENERIC_CHOICE_LABEL = /^선택항목\d+$/;
const EXPLICIT_REJECTION_SIGNAL = /(표 머리글|표 첫 행의 긴 제목 가능성|표 첫 행의 머리글 가능성|단위 가능성|목차 제목|고정 날짜 문구|제목·설명문|값 placeholder|양식 개체로 대체|구조가 더 구체적인|머리글을 값으로 오인|선택지 위치가 없는|LLM 맥락 판정: 입력 대상 아님|RHWP native 문단 결속 불가로 안전 제외)/;

/**
 * 후보 판정의 마지막 seam. 구조적으로 안전하지 않은 거대 후보는 제외하고,
 * 아직 설명되지 않은 빈 셀은 review_required 로 남겨 호출자가 완성으로 오인하지 않게 한다.
 */
export function finalizeRoundtripFieldCoverage(
  fields: RoundtripFieldCandidate[],
): RoundtripFieldCoverageSummary {
  const structuralWarnings = suppressCollapsedContextualFields(fields);
  const unresolvedCandidates = fields.flatMap((field): RoundtripFieldCoverageIssue[] => {
    if (field.source === "contextual-region" || !field.empty || field.recommendedInput) return [];
    if (hasResolvedRejection(field)) return [];
    return [issue(field, field.required
      ? "필수 표시가 있는 빈 셀이 입력 대상에서 제외됨"
      : "빈 양식 셀을 입력 대상 또는 비입력 영역으로 확정하지 못함")];
  });
  const acceptedFields = fields.filter((field) => field.recommendedInput);
  const anchorUnready = acceptedFields.filter((field) => !hasRhwpAnchorContract(field));
  for (const field of anchorUnready) {
    unresolvedCandidates.push(issue(field, "원문 라벨과 RHWP 구조 위치를 함께 확정하지 못함"));
  }
  const status: RoundtripFieldCoverageSummary["status"] = unresolvedCandidates.length > 0
    ? "review_required"
    : structuralWarnings.length > 0
      ? "partial"
      : "complete";
  return {
    status,
    rawEmptyCandidateCount: fields.filter((field) => field.source !== "contextual-region" && field.empty).length,
    acceptedInputCount: acceptedFields.length,
    unresolvedCandidateCount: unresolvedCandidates.length,
    structuralWarningCount: structuralWarnings.length,
    unresolvedCandidates,
    structuralWarnings,
    structuralInputLabelCount: fields.filter((field) => field.source === "rhwp-structural").length,
    anchorReadyInputCount: acceptedFields.length - anchorUnready.length,
    anchorUnreadyInputCount: anchorUnready.length,
  };
}

export function emptyRoundtripFieldCoverage(): RoundtripFieldCoverageSummary {
  return {
    status: "complete",
    rawEmptyCandidateCount: 0,
    acceptedInputCount: 0,
    unresolvedCandidateCount: 0,
    structuralWarningCount: 0,
    unresolvedCandidates: [],
    structuralWarnings: [],
    structuralInputLabelCount: 0,
    anchorReadyInputCount: 0,
    anchorUnreadyInputCount: 0,
  };
}

function hasRhwpAnchorContract(field: RoundtripFieldCandidate): boolean {
  const anchorLabel = field.label.normalize("NFKC").replace(/\s+/gu, "").trim();
  if (anchorLabel.length < 2 || GENERIC_CHOICE_LABEL.test(field.normalizedLabel)) return false;
  if (!Number.isSafeInteger(field.location.blockIndex) || field.location.blockIndex < 0) return false;
  const target = field.location.target;
  if (target?.kind === "paragraph_text") {
    return field.location.row === -1
      && field.location.col === -1
      && typeof target.paragraphPrefix === "string"
      && typeof target.paragraphSuffix === "string"
      && Number.isSafeInteger(target.paragraphOccurrence)
      && (target.paragraphOccurrence ?? -1) >= 0
      && target.textStart === target.paragraphPrefix.length
      && target.textEnd >= target.textStart;
  }
  if (!Number.isSafeInteger(field.location.row) || field.location.row < 0) return false;
  if (!Number.isSafeInteger(field.location.col) || field.location.col < 0) return false;
  // 본문 전체 문자열 교체는 RHWP 표 셀/누름틀 exact binding과 다른 편집 계약이다.
  return target?.kind !== "block_text";
}

function suppressCollapsedContextualFields(
  fields: RoundtripFieldCandidate[],
): RoundtripFieldCoverageIssue[] {
  const warnings: RoundtripFieldCoverageIssue[] = [];
  for (const field of fields) {
    if (field.source !== "contextual-region" || field.writeOperation !== "toggle_text_choice") continue;
    const targetLength = field.location.target?.expectedText.length ?? field.originalValue.length;
    const collapsed = targetLength >= COLLAPSED_CONTEXT_LENGTH
      || (GENERIC_CHOICE_LABEL.test(field.normalizedLabel) && targetLength >= GENERIC_CHOICE_COLLAPSED_LENGTH);
    if (!collapsed) continue;
    field.recommendedInput = false;
    field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
    const reason = "문서의 넓은 구간이 한 셀로 접혀 선택 항목의 정확한 쓰기 위치를 확정할 수 없음";
    field.inputSignals.push(reason);
    warnings.push(issue(field, reason));
  }
  return warnings;
}

function hasResolvedRejection(field: RoundtripFieldCandidate): boolean {
  if (field.analysisSource === "llm" && (field.llmConfidence ?? 0) >= 0.75) return true;
  return field.inputSignals.some((signal) => EXPLICIT_REJECTION_SIGNAL.test(signal));
}

function issue(field: RoundtripFieldCandidate, reason: string): RoundtripFieldCoverageIssue {
  return {
    fieldInstanceId: field.fieldInstanceId,
    label: field.displayLabel || field.label,
    reason,
    location: {
      blockIndex: field.location.blockIndex,
      row: field.location.row,
      col: field.location.col,
      occurrence: field.location.occurrence,
      pageNumber: field.location.pageNumber,
    },
  };
}
