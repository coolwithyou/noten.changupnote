import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";

export const APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA =
  "analysis-lab-application-field-repair-aggregate-v1" as const;
export const APPLICATION_FIELD_REPAIR_SHADOW_SCHEMA =
  "analysis-lab-application-field-repair-shadow-v1" as const;
export const APPLICATION_FIELD_REPAIR_DRY_RUN_SCHEMA =
  "analysis-lab-application-field-repair-dry-run-v1" as const;
export const APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA =
  "analysis-lab-application-field-repair-approval-v1" as const;
export const APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA =
  "analysis-lab-application-field-repair-verification-v1" as const;

export type ApplicationFieldRepairGateName =
  | "aggregate.json"
  | "shadow.json"
  | "dry-run.json";

export interface ApplicationFieldRepairArtifactBinding {
  releaseKind: "application_field_repair";
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  grantId: string;
  parentPromotionItemId: string;
}

export interface ApplicationFieldRepairGateExpectation {
  schema: string;
  verdict: "GO" | "PASS";
  evidence: Record<string, unknown>;
}

export interface ApplicationFieldRepairApprovalLedger {
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  approvalArtifactSha256: string | null;
  gateSummary: unknown;
}

export function validateApplicationFieldRepairGateArtifact(input: {
  value: unknown;
  binding: ApplicationFieldRepairArtifactBinding;
  expectation: ApplicationFieldRepairGateExpectation;
}): Record<string, unknown> {
  const value = record(input.value, "application repair gate");
  const { binding, expectation } = input;
  if (
    value.schema !== expectation.schema
    || value.releaseKind !== binding.releaseKind
    || value.releaseId !== binding.releaseId
    || value.releasePlanSha256 !== binding.releasePlanSha256
    || value.manifestSha256 !== binding.manifestSha256
    || value.grantId !== binding.grantId
    || value.parentPromotionItemId !== binding.parentPromotionItemId
    || value.matchingMutationCount !== 0
    || value.verdict !== expectation.verdict
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("application repair gate 공통 provenance가 다릅니다.");
  }
  for (const [key, expected] of Object.entries(expectation.evidence)) {
    if (sha256Canonical(value[key]) !== sha256Canonical(expected)) {
      throw new Error(`application repair gate evidence가 다릅니다: ${key}`);
    }
  }
  return value;
}

export function validateApplicationFieldRepairApprovalArtifact(input: {
  value: unknown;
  artifactSha256: string;
  binding: ApplicationFieldRepairArtifactBinding;
  ledger: ApplicationFieldRepairApprovalLedger;
  gateSha256s: {
    aggregateSha256: string;
    shadowSha256: string;
    dryRunSha256: string;
  };
  executingActor: string;
}): Record<string, unknown> {
  const approval = record(input.value, "application repair approval");
  const { binding, ledger, gateSha256s } = input;
  const summary = record(ledger.gateSummary, "application repair DB gate summary");
  if (
    ledger.status !== "approved"
      && ledger.status !== "canary_passed"
      && ledger.status !== "active"
  ) {
    throw new Error(`application repair write 상태가 승인 범위가 아닙니다: ${ledger.status}`);
  }
  if (
    approval.schema !== APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA
    || approval.releaseKind !== binding.releaseKind
    || approval.releaseId !== binding.releaseId
    || approval.releasePlanSha256 !== binding.releasePlanSha256
    || approval.manifestSha256 !== binding.manifestSha256
    || approval.aggregateSha256 !== gateSha256s.aggregateSha256
    || approval.shadowSha256 !== gateSha256s.shadowSha256
    || approval.dryRunSha256 !== gateSha256s.dryRunSha256
    || approval.approvedBy !== ledger.approvedBy
    || typeof approval.approvedAt !== "string"
    || !Number.isFinite(Date.parse(approval.approvedAt))
    || approval.approvedAt !== ledger.approvedAt?.toISOString()
    || input.artifactSha256 !== ledger.approvalArtifactSha256
    || summary.aggregateSha256 !== gateSha256s.aggregateSha256
    || summary.shadowSha256 !== gateSha256s.shadowSha256
    || summary.dryRunSha256 !== gateSha256s.dryRunSha256
  ) {
    throw new Error("application repair approval artifact와 DB 원장 provenance가 다릅니다.");
  }
  if (!ledger.approvedBy || ledger.approvedBy === input.executingActor) {
    throw new Error("application repair 승인자와 실행자는 달라야 합니다.");
  }
  return approval;
}

export function validateApplicationFieldRepairVerificationArtifact(input: {
  value: unknown;
  binding: ApplicationFieldRepairArtifactBinding;
  scope: "canary" | "all";
  attempt: number;
  expectedFieldCount: number;
  verdict: "PASS" | "FAIL";
  expectedServingStateSha256?: string;
}): Record<string, unknown> {
  const value = record(input.value, "application repair verification");
  if (
    value.schema !== APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA
    || value.releaseKind !== input.binding.releaseKind
    || value.releaseId !== input.binding.releaseId
    || value.releasePlanSha256 !== input.binding.releasePlanSha256
    || value.manifestSha256 !== input.binding.manifestSha256
    || value.grantId !== input.binding.grantId
    || value.scope !== input.scope
    || value.attempt !== input.attempt
    || value.expectedFieldCount !== input.expectedFieldCount
    || value.verdict !== input.verdict
    || !Array.isArray(value.reasons)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || (input.verdict === "PASS" && value.reasons.length !== 0)
    || (input.expectedServingStateSha256 !== undefined
      && value.currentServingStateSha256 !== input.expectedServingStateSha256)
  ) {
    throw new Error("application repair verification receipt provenance가 다릅니다.");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}
