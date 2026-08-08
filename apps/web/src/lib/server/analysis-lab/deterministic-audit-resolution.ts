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
  "lab-deterministic-audit-v2" as const;

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

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
