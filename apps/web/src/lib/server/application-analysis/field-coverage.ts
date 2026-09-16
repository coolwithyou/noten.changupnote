// 제품과 실험실이 공유하는 문서 분석 구현. 실행 승인·로컬 artifact 저장은 호출자가 소유한다.
import { createHash } from "node:crypto";
import type { IRBlock } from "kordoc";
import type {
  RoundtripDocumentRole,
  RoundtripFieldCandidate,
  RoundtripFieldCoverageIssue,
  RoundtripFieldCoverageSummary,
} from "./contract";
import {
  hasFixedTableRoleRejection,
  hasNonOverridableStructuralRejection,
  isUnsupportedNestedMediaTextTarget,
  normalizeRoundtripLabel,
} from "./core";

const COLLAPSED_CONTEXT_LENGTH = 400;
const GENERIC_CHOICE_COLLAPSED_LENGTH = 120;
const GENERIC_CHOICE_LABEL = /^선택항목\d+$/;
const EXPLICIT_REJECTION_SIGNAL = /(표 머리글|표 첫 행의 긴 제목 가능성|표 첫 행의 머리글 가능성|단위 가능성|목차 제목|고정 날짜 문구|제목·설명문|양식 개체로 대체|구조가 더 구체적인|머리글을 값으로 오인|선택지 위치가 없는|RHWP native 문단 결속 불가로 안전 제외)/;
const FIXED_MARKER_VALUE = /^[-‐‑‒–—―]$/u;
const FIXED_MARKER_SIGNAL = /(?:고정.{0,12}(?:표기|문자|값|기호|마커)|(?:표기|문자|값|기호|마커).{0,12}고정)/u;
const NON_INPUT_SIGNAL = /(?:입력\s*(?:대상|영역|항목)(?:이|가)?\s*(?:아님|아닙|아니|제외)|비입력\s*(?:대상|영역|항목)|작성\s*(?:대상|영역|항목)(?:이|가)?\s*(?:아님|아닙|아니|제외))/u;
const INLINE_EMPTY_NUMBER_SLOT = /[:：][\t ]{2,}(?:명|개|건)(?=[\s/]|$)/gu;
const LEADING_TEXT_CHECKBOX = /(?:^|\n)\s*[□☐■☑✓]/u;
const POST_PLANNER_CONTEXT_REPLACEMENT = /^구조가 더 구체적인 “(.+)” 입력으로 대체$/u;
const SHORT_LABEL_INPUT_CONFIDENCE = 0.75;

/**
 * 후보 판정의 마지막 seam. 구조적으로 안전하지 않은 거대 후보는 제외하고,
 * 아직 설명되지 않은 빈 셀은 review_required 로 남겨 호출자가 완성으로 오인하지 않게 한다.
 */
export function finalizeRoundtripFieldCoverage(
  fields: RoundtripFieldCandidate[],
  unsupportedNativeGaps: readonly RoundtripFieldCoverageIssue[] = [],
  blocks: readonly IRBlock[] = [],
): RoundtripFieldCoverageSummary {
  const structuralWarnings = [
    ...unsupportedNativeGaps,
    ...suppressCollapsedContextualFields(fields),
  ];
  const unresolvedCandidates = fields.flatMap((field): RoundtripFieldCoverageIssue[] => {
    if (!isRoundtripFieldCoverageUnresolvedCandidate(field, fields)) return [];
    return [issue(field, field.required
      ? "필수 표시가 있는 빈 셀이 입력 대상에서 제외됨"
      : "빈 양식 셀을 입력 대상 또는 비입력 영역으로 확정하지 못함")];
  });
  const acceptedFields = fields.filter((field) => field.recommendedInput);
  const anchorUnready = acceptedFields.filter((field) => !hasRhwpAnchorContract(field, blocks));
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

/**
 * coverage가 입력/비입력 어느 쪽으로도 종결하지 못한 빈 후보다. 구독 LLM triage가
 * 점수 임계만으로 이 후보를 건너뛰지 않도록 planner와 같은 판정 seam을 공유한다.
 */
export function isRoundtripFieldCoverageUnresolvedCandidate(
  field: RoundtripFieldCandidate,
  fields: readonly RoundtripFieldCandidate[] = [],
): boolean {
  return field.source !== "contextual-region"
    && field.empty
    && !field.recommendedInput
    && !hasResolvedRejection(field, fields);
}

/**
 * 현재 writer가 exact subrange로 결속하지 못한 명시적 입력 흔적만 경고한다.
 * 후보를 새 입력으로 승격하거나 값을 추정하지 않으며, 신청 역할 밖 문서는 검사하지 않는다.
 */
export function detectUnsupportedNativeInputGaps(input: {
  blocks: readonly IRBlock[];
  fields: readonly RoundtripFieldCandidate[];
  role: RoundtripDocumentRole;
}): RoundtripFieldCoverageIssue[] {
  if (
    input.role !== "application_form"
    && input.role !== "business_plan"
    && input.role !== "mixed_form"
  ) return [];

  const warnings: RoundtripFieldCoverageIssue[] = [];
  input.blocks.forEach((block, blockIndex) => {
    if (block.type !== "table" || !block.table) return;
    block.table.cells.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        const text = cell.text.normalize("NFKC");
        const inlineSlotCount = [...text.matchAll(INLINE_EMPTY_NUMBER_SLOT)].length;
        const unsupportedKind = isUnsupportedNestedMediaTextTarget(row, colIndex, cell)
          ? "nested_media"
          : inlineSlotCount >= 2
          ? "inline_number_slots"
          : LEADING_TEXT_CHECKBOX.test(text)
            ? "text_checkbox"
            : null;
        if (!unsupportedKind || hasExactCellTarget(input.fields, blockIndex, rowIndex, colIndex)) return;
        const label = text.replace(/\s+/gu, " ").trim().slice(0, 100) || "미지원 입력 영역";
        warnings.push({
          fieldInstanceId: createHash("sha256")
            .update(`unsupported-native-gap:${unsupportedKind}:${blockIndex}:${rowIndex}:${colIndex}:${text}`)
            .digest("hex")
            .slice(0, 24),
          label,
          reason: unsupportedKind === "inline_number_slots"
            ? "한 셀 안의 복수 숫자 입력 위치를 각각 exact하게 결속하지 못해 원문 직접 확인이 필요함"
            : unsupportedKind === "nested_media"
              ? "이미지·설계도 삽입용 nested 영역은 현재 텍스트 writer로 결속할 수 없어 원문 직접 편집이 필요함"
            : "텍스트 체크박스의 exact marker 쓰기 위치를 결속하지 못해 원문 직접 확인이 필요함",
          location: {
            blockIndex,
            row: rowIndex,
            col: colIndex,
            occurrence: 0,
            pageNumber: block.pageNumber ?? null,
          },
        });
      });
      for (const field of input.fields) {
        if (
          !hasFixedTableRoleRejection(field)
          || field.location.blockIndex !== blockIndex
          || field.location.row !== rowIndex
        ) continue;
        const labelCell = row[field.location.col];
        if (!labelCell) continue;
        const valueStart = field.location.col + Math.max(1, labelCell.colSpan);
        const uncoveredValueCols = row
          .map((cell, col) => ({ cell, col }))
          .slice(valueStart)
          .filter(({ cell, col }) => (
            cell.text.trim() === ""
            && !hasExactCellTarget(input.fields, blockIndex, rowIndex, col)
          ))
          .map(({ col }) => col);
        const firstUncoveredCol = uncoveredValueCols[0];
        if (firstUncoveredCol === undefined) continue;
        warnings.push({
          fieldInstanceId: createHash("sha256")
            .update(`unsupported-fixed-matrix-values:${field.fieldInstanceId}:${uncoveredValueCols.join(",")}`)
            .digest("hex")
            .slice(0, 24),
          label: field.displayLabel,
          reason: `고정 분류·집계 라벨은 입력값으로 쓸 수 없고 인접 다열 빈 값 ${uncoveredValueCols.length}개를 현재 writer가 각각 exact 결속하지 못함`,
          location: {
            blockIndex,
            row: rowIndex,
            col: firstUncoveredCol,
            occurrence: field.location.occurrence,
            pageNumber: field.location.pageNumber,
          },
        });
      }
    });
  });
  return warnings;
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

function hasRhwpAnchorContract(
  field: RoundtripFieldCandidate,
  blocks: readonly IRBlock[],
): boolean {
  const anchorLabel = field.label.normalize("NFKC").replace(/\s+/gu, "").trim();
  if (GENERIC_CHOICE_LABEL.test(field.normalizedLabel)) return false;
  if (anchorLabel.length < 2 && !hasExactShortKordocTableAnchor(field, blocks)) return false;
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

/**
 * 한 글자 라벨은 이름만으로 쓰기 위치를 열지 않는다. 같은 원본 parse에서 label 좌표,
 * 동명 occurrence, 오른쪽 값 셀이 모두 exact하게 일치하고 기존 입력 임계도 통과한 경우만
 * Kordoc label/occurrence writer 계약을 인정한다.
 */
function hasExactShortKordocTableAnchor(
  field: RoundtripFieldCandidate,
  blocks: readonly IRBlock[],
): boolean {
  if (
    field.source !== "kordoc-form"
    || field.writeOperation !== "kordoc_field"
    || field.location.target !== undefined
    || field.analysisSource !== "llm"
    || field.llmDecision !== "input"
    || !Number.isFinite(field.llmConfidence)
    || (field.llmConfidence ?? 0) < SHORT_LABEL_INPUT_CONFIDENCE
    || !field.empty
  ) return false;
  const { blockIndex, row: rowIndex, col: colIndex, occurrence } = field.location;
  if (![blockIndex, rowIndex, colIndex, occurrence].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return false;
  }
  if (!field.normalizedLabel || normalizeRoundtripLabel(field.label) !== field.normalizedLabel) return false;
  const block = blocks[blockIndex];
  const row = block?.type === "table" ? block.table?.cells[rowIndex] : undefined;
  const labelCell = row?.[colIndex];
  if (
    !block
    || !row
    || !labelCell
    || labelCell.colSpan !== 1
    || labelCell.rowSpan !== 1
    || normalizeRoundtripLabel(labelCell.text) !== field.normalizedLabel
  ) return false;
  const targetCol = colIndex + Math.max(1, labelCell.colSpan);
  const target = row[targetCol];
  if (
    !target
    || target.colSpan !== 1
    || target.rowSpan !== 1
    || target.text.normalize("NFKC").trim() !== field.originalValue.normalize("NFKC").trim()
  ) return false;
  // 병합 anchor의 covered cell은 독립 값 칸으로 열지 않는다.
  for (let r = 0; r <= rowIndex; r += 1) {
    for (let c = 0; c <= targetCol; c += 1) {
      const cell = block.table!.cells[r]?.[c];
      if (!cell || r + cell.rowSpan <= rowIndex) continue;
      if ((r !== rowIndex || c !== colIndex) && c <= colIndex && c + cell.colSpan > colIndex) return false;
      if ((r !== rowIndex || c !== targetCol) && c <= targetCol && c + cell.colSpan > targetCol) return false;
    }
  }

  let observedOccurrence = 0;
  for (let currentBlock = 0; currentBlock <= blockIndex; currentBlock += 1) {
    const table = blocks[currentBlock]?.table;
    if (!table) continue;
    for (let currentRow = 0; currentRow < table.cells.length; currentRow += 1) {
      const cells = table.cells[currentRow] ?? [];
      for (let currentCol = 0; currentCol < cells.length; currentCol += 1) {
        if (normalizeRoundtripLabel(cells[currentCol]?.text ?? "") !== field.normalizedLabel) continue;
        // 단문은 괄호·기호를 지운 느슨한 동명 hit가 native 순번에 섞이지 않게 한다.
        if ((cells[currentCol]?.text ?? "").normalize("NFKC").replace(/\s+/gu, "")
          !== field.label.normalize("NFKC").replace(/\s+/gu, "")) return false;
        if (
          currentBlock === blockIndex
          && currentRow === rowIndex
          && currentCol === colIndex
        ) return observedOccurrence === occurrence;
        observedOccurrence += 1;
      }
    }
  }
  return false;
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

function hasExactCellTarget(
  fields: readonly RoundtripFieldCandidate[],
  blockIndex: number,
  row: number,
  col: number,
): boolean {
  return fields.some((field) => field.recommendedInput
    && field.location.blockIndex === blockIndex
    && field.location.target?.kind === "table_cell"
    && field.location.target.row === row
    && field.location.target.col === col);
}

function hasResolvedRejection(
  field: RoundtripFieldCandidate,
  fields: readonly RoundtripFieldCandidate[],
): boolean {
  if (hasNonOverridableStructuralRejection(field)) return true;
  // planner의 양의 판정 뒤에도 RHWP가 더 정확한 쓰기 대상을 만들 수 있다. 이 신호는
  // 동일 후보를 막연히 거절한 이력이 아니라 exact contextual 입력으로 대체했다는 구조 증거다.
  if (field.inputSignals.some((signal) => {
    const replacementLabel = POST_PLANNER_CONTEXT_REPLACEMENT.exec(signal)?.[1];
    return replacementLabel !== undefined && fields.some((candidate) => (
      candidate.source === "contextual-region"
      && candidate.recommendedInput
      && candidate.label === replacementLabel
      && candidate.location.blockIndex === field.location.blockIndex
      && Math.abs(candidate.location.row - field.location.row) <= 1
      && (candidate.normalizedLabel.startsWith(field.normalizedLabel)
        || field.normalizedLabel.startsWith(candidate.normalizedLabel))
    ));
  })) return true;
  const locatedLlmRejection = (
    field.analysisSource === "llm"
    && field.llmDecision === "not_input"
    && (field.llmConfidence ?? 0) >= 0.75
    && field.inputSignals.includes("LLM 비입력 근거의 구조 위치 결속 확인")
  );
  const explanatoryText = [field.displayLabel, field.helperText]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .normalize("NFKC");
  // 현재 최종 판정이 해당 구조 위치의 연속 인용을 통과했다면 과거 라운드의 실패 signal은
  // 진단 이력일 뿐이다. 반대로 current uncertain은 오래된 성공 marker로 종결하지 않는다.
  if (locatedLlmRejection) return true;
  if (
    field.analysisSource === "llm"
    && field.inputSignals.includes("LLM 비입력 근거 위치 불일치 또는 누락")
  ) {
    return false;
  }
  if (
    FIXED_MARKER_VALUE.test(field.originalValue.normalize("NFKC").trim())
    && FIXED_MARKER_SIGNAL.test(explanatoryText)
    && NON_INPUT_SIGNAL.test(explanatoryText)
  ) {
    return true;
  }
  // LLM을 거친 후보는 현재 최종 decision과 구조 근거만 본다. 앞 라운드나 heuristic의
  // 오래된 비입력 signal이 뒤의 uncertain 결정을 우회해 complete로 닫지 못하게 한다.
  if (field.analysisSource === "llm") return false;
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
