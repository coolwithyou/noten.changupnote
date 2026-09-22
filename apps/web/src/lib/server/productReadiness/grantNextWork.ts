import type { GrantReadiness } from "./grantReadiness";

export const GRANT_NEXT_WORK_SCHEMA = "grant-next-work-v1" as const;

export type GrantNextWorkAction =
  | "source_recovery"
  | "source_change_review"
  | "condition_analysis"
  | "condition_review"
  | "question_preparation"
  | "reuse_ready";

export interface GrantNextWork {
  readonly schema: typeof GRANT_NEXT_WORK_SCHEMA;
  readonly action: GrantNextWorkAction;
  readonly requiresModelRun: boolean;
  readonly blockerCodes: GrantReadiness["blockerCodes"];
}

const SOURCE_RECOVERY = new Set([
  "source_missing",
  "source_revision_missing",
  "source_raw_missing",
  "attachments_missing",
]);
const SOURCE_CHANGE = new Set([
  "source_revision_changed",
  "source_raw_changed",
  "attachment_manifest_changed",
]);
const CONDITION_REVIEW = new Set([
  "analysis_source_binding_missing",
  "analysis_attachment_binding_missing",
  "attachment_manifest_missing",
  "criteria_structure_incomplete",
  "criteria_review_incomplete",
  "eligible_question_key_missing",
]);

/** 준비도 원인을 모델 실행과 혼동하지 않고 다음 최소 작업으로 축소한다. */
export function planGrantNextWork(readiness: GrantReadiness): GrantNextWork {
  const blockers = readiness.blockerCodes;
  if (blockers.some((blocker) => SOURCE_RECOVERY.has(blocker))) {
    return work("source_recovery", false, blockers);
  }
  if (blockers.some((blocker) => SOURCE_CHANGE.has(blocker))) {
    return work("source_change_review", false, blockers);
  }
  if (blockers.includes("analysis_missing")) {
    return work("condition_analysis", true, blockers);
  }
  if (blockers.some((blocker) => CONDITION_REVIEW.has(blocker))) {
    return work("condition_review", false, blockers);
  }
  if (blockers.length > 0) {
    return work("question_preparation", false, blockers);
  }
  return work("reuse_ready", false, blockers);
}

function work(
  action: GrantNextWorkAction,
  requiresModelRun: boolean,
  blockerCodes: GrantReadiness["blockerCodes"],
): GrantNextWork {
  return Object.freeze({ schema: GRANT_NEXT_WORK_SCHEMA, action, requiresModelRun, blockerCodes });
}
