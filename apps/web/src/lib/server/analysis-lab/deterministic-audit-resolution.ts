// 독립 AI 검수의 불일치를 자격조건에서 일반적으로 덮지 않는다. 제품 계약으로
// 참·거짓이 결정되는 극히 좁은 오판과, 자격과 분리된 preferred criterion의
// 보수적 억제만 자동 종결한다. 정책 버전과 criterion index를 승격 증거에 봉인한다.
import type {
  LabAuditItem,
  LabCriterion,
  LabCriterionVerdict,
  LabRun,
} from "@/features/dev/analysis-lab/contract";

export const LAB_DETERMINISTIC_AUDIT_POLICY_VERSION =
  "lab-deterministic-audit-v3" as const;

export interface DeterministicAuditResolution {
  verdict: Exclude<LabCriterionVerdict, "unsure">;
  policyVersion: typeof LAB_DETERMINISTIC_AUDIT_POLICY_VERSION;
  note: string;
}

/**
 * same_project는 과거 수혜 records가 아니라 현재 동시 참여 self flag를 읽는 core 계약이다.
 * 따라서 원문이 동일 사업/과제의 중복 참여를 명시하고 독립 감사도 criterion을 correct로
 * 확인했는데 1차 검수만 이를 과거 수혜 배제로 오해한 경우에는 계약 사실로 해소할 수 있다.
 */
export function resolveDeterministicAuditDisagreement(
  run: LabRun,
  item: LabAuditItem,
): DeterministicAuditResolution | null {
  const sameProjectResolution = resolveCurrentSameProjectDisagreement(run, item);
  if (sameProjectResolution) return sameProjectResolution;

  const structuredTargetResolution = resolveOfficialStructuredTargetDisagreement(run, item);
  if (structuredTargetResolution) return structuredTargetResolution;

  return resolvePreferredCriterionDisagreement(run, item);
}

function resolveCurrentSameProjectDisagreement(
  run: LabRun,
  item: LabAuditItem,
): DeterministicAuditResolution | null {
  if (
    item.kind !== "criterion"
    || item.criterionIndex === undefined
    || item.humanVerdict !== null
    || item.aiVerdict !== "needs_edit"
    || item.aiAuditVerdict !== "correct"
  ) {
    return null;
  }
  const criterion = run.criteria[item.criterionIndex];
  if (!criterion || !isCurrentSameProjectExclusion(criterion)) return null;
  if (!reviewMistookCurrentParticipationForPastAward(item.aiNote)) return null;

  return {
    verdict: "correct",
    policyVersion: LAB_DETERMINISTIC_AUDIT_POLICY_VERSION,
    note:
      "결정 규칙: prior_award/self/same_project는 과거 수혜 records가 아니라 동일 과제의 현재 동시 참여 self flag를 판정한다.",
  };
}

/**
 * Bizinfo의 trgetNm은 공식 신청대상 필드다. 원문 서식의 기업유형 기재란은
 * 정보수집 항목일 뿐 자격 문장이 아니므로, 정확히 이 둘을 혼동한 1차 검수만
 * 독립 감사의 correct 판정으로 해소한다. 본문 충돌 일반화에는 사용하지 않는다.
 */
function resolveOfficialStructuredTargetDisagreement(
  run: LabRun,
  item: LabAuditItem,
): DeterministicAuditResolution | null {
  if (
    item.kind !== "criterion"
    || item.criterionIndex === undefined
    || item.humanVerdict !== null
    || item.aiVerdict !== "needs_edit"
    || item.aiAuditVerdict !== "correct"
  ) {
    return null;
  }
  const criterion = run.criteria[item.criterionIndex];
  if (!criterion || !isOfficialStructuredSizeCriterion(criterion)) return null;
  if (!reviewMistookApplicationMetadataForEligibility(item.aiNote)) return null;

  return {
    verdict: "correct",
    policyVersion: LAB_DETERMINISTIC_AUDIT_POLICY_VERSION,
    note:
      "결정 규칙: Bizinfo trgetNm은 공식 신청대상 근거이고, 신청서의 기업유형 기재란은 명시적 자격 문장이 아니므로 지원 규모 조건을 뒤집지 않는다.",
  };
}

/**
 * preferred는 신청 가능 여부가 아니라 순위만 바꾼다. 두 모델 중 하나라도
 * needs_edit/wrong이라면 더 낙관적인 correct 판정을 채택하지 않고 해당
 * 우대조건만 매칭 점수에서 제외한다. unsure는 근거가 없으므로 자동 종결하지 않는다.
 */
function resolvePreferredCriterionDisagreement(
  run: LabRun,
  item: LabAuditItem,
): DeterministicAuditResolution | null {
  if (
    item.kind !== "criterion"
    || item.criterionIndex === undefined
    || item.humanVerdict !== null
    || !isDecisiveCriterionVerdict(item.aiVerdict)
    || !isDecisiveCriterionVerdict(item.aiAuditVerdict)
    || item.aiVerdict === item.aiAuditVerdict
  ) {
    return null;
  }
  const criterion = run.criteria[item.criterionIndex];
  if (!criterion || criterion.kind !== "preferred") return null;
  if (!hasActionablePreferredFinding(item)) return null;

  const verdict = item.aiVerdict === "wrong" || item.aiAuditVerdict === "wrong"
    ? "wrong"
    : "needs_edit";
  return {
    verdict,
    policyVersion: LAB_DETERMINISTIC_AUDIT_POLICY_VERSION,
    note:
      `보수적 우대조건 규칙: 1차 검수(${item.aiVerdict})와 독립 감사(${item.aiAuditVerdict}) 중 `
      + `하나가 구체적 오류를 지적해 해당 preferred criterion만 매칭 점수에서 제외한다.`,
  };
}

function hasActionablePreferredFinding(item: LabAuditItem): boolean {
  return (
    (item.aiVerdict === "needs_edit" || item.aiVerdict === "wrong")
    && normalize(item.aiNote).length > 0
  ) || (
    (item.aiAuditVerdict === "needs_edit" || item.aiAuditVerdict === "wrong")
    && normalize(item.aiAuditNote).length > 0
  );
}

function isDecisiveCriterionVerdict(
  verdict: LabCriterionVerdict | string | null | undefined,
): verdict is Exclude<LabCriterionVerdict, "unsure"> {
  return verdict === "correct" || verdict === "needs_edit" || verdict === "wrong";
}

function isCurrentSameProjectExclusion(criterion: LabCriterion): boolean {
  if (
    criterion.dimension !== "prior_award"
    || criterion.kind !== "exclusion"
    || criterion.operator !== "exists"
  ) {
    return false;
  }
  const value = record(criterion.value);
  if (
    value.scope !== "self"
    || value.self_kind !== "same_project"
    || (value.channel !== undefined && value.channel !== "general")
  ) {
    return false;
  }
  const span = normalize(criterion.sourceSpan);
  return /동일\s*(?:사업|과제)/.test(span)
    && /(?:중복\s*(?:참여|신청)|(?:참여|신청)\s*중복)/.test(span)
    && /(?:불가|금지|제외)/.test(span);
}

function reviewMistookCurrentParticipationForPastAward(note: string | null): boolean {
  const normalized = normalize(note);
  return /(?:과거|기수혜|수혜\s*이력|과거\s*연도)/.test(normalized)
    && /(?:동시|중복\s*참여)/.test(normalized);
}

function isOfficialStructuredSizeCriterion(criterion: LabCriterion): boolean {
  if (
    criterion.dimension !== "size"
    || criterion.kind !== "required"
    || criterion.operator !== "in"
    || criterion.spanVerified !== true
  ) {
    return false;
  }
  const span = normalize(criterion.sourceSpan);
  const note = normalize(criterion.note);
  return /지원대상\s*:/.test(span)
    && /source_field\s*:\s*trgetNm/i.test(span)
    && /Bizinfo\s*공식\s*신청대상\s*필드/i.test(note)
    && /(?:기재란|정보\s*수집)/.test(note)
    && /자격\s*(?:근거|문장)/.test(note);
}

function reviewMistookApplicationMetadataForEligibility(note: string | null): boolean {
  const normalized = normalize(note);
  return /trgetNm/i.test(normalized)
    && /(?:신청서|서식)/.test(normalized)
    && /(?:기업\s*유형|스타트업|중견기업|그외)/.test(normalized)
    && /(?:기재|병기|상정|선택지)/.test(normalized);
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
