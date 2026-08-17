import {
  DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_REQUIRED_STRATA,
} from "./deep-repair-formal-policy";
import type { DeepRepairPlanningTarget } from "./cohort";

export const DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE = 10;
export const DEEP_REPAIR_INITIAL_KORDOC_LLM_CANDIDATE_LIMIT = 240;
export const DEEP_REPAIR_INITIAL_MIN_REMAINING_DAYS = 7;

export interface DeepRepairKordocReadiness {
  readonly grantId: string;
  readonly selectedDocumentCount: number;
  readonly fieldCandidateCount: number;
  readonly llmCandidateCount: number;
  readonly sourceSha256s: readonly string[];
  readonly releaseWindowReady: boolean;
}

/**
 * 층화로 뽑은 30건은 그대로 보존하되, 첫 출시 변환 10건에는 실제 Kordoc 신청 양식이
 * 있고 경계 후보 수가 초기 배치 상한 안인 공고만 배치한다. 첫 wave의 5층 보장은 이어서
 * 채우므로 기존 formal evaluator 계약도 바꾸지 않는다.
 */
export function prioritizeDeepRepairTargetsForInitialKordocCohort<
  T extends Pick<DeepRepairPlanningTarget, "grantId" | "stratum">,
>(
  targets: readonly T[],
  readiness: readonly DeepRepairKordocReadiness[],
): T[] {
  const readinessByGrantId = new Map(readiness.map((item) => [item.grantId, item] as const));
  const eligible = targets.filter((target) => {
    const item = readinessByGrantId.get(target.grantId);
    return Boolean(
      item
      && item.selectedDocumentCount > 0
      && item.fieldCandidateCount > 0
      && item.llmCandidateCount > 0
      && item.llmCandidateCount <= DEEP_REPAIR_INITIAL_KORDOC_LLM_CANDIDATE_LIMIT
      && item.sourceSha256s.length > 0
      && item.releaseWindowReady,
    );
  });
  if (eligible.length < DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE) {
    throw new Error(
      `initial release cohort inventory insufficient: expected ${DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE} Kordoc-ready targets, got ${eligible.length}`,
    );
  }

  const priority = eligible.slice(0, DEEP_REPAIR_INITIAL_RELEASE_COHORT_SIZE);
  const priorityIds = new Set(priority.map((target) => target.grantId));
  const remaining = targets.filter((target) => !priorityIds.has(target.grantId));
  const prefix: T[] = [...priority];

  for (const stratum of DEEP_REPAIR_FORMAL_REQUIRED_STRATA) {
    if (prefix.some((target) => target.stratum === stratum)) continue;
    const index = remaining.findIndex((target) => target.stratum === stratum);
    if (index < 0) throw new Error(`initial release cohort cannot preserve required stratum: ${stratum}`);
    prefix.push(remaining.splice(index, 1)[0]!);
  }
  while (prefix.length < DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE) {
    const next = remaining.shift();
    if (!next) throw new Error("initial release cohort cannot fill the first formal wave");
    prefix.push(next);
  }

  return [...prefix, ...remaining];
}
