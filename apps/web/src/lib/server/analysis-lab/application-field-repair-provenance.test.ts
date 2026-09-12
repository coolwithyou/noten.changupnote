import assert from "node:assert/strict";
import {
  APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
  APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA,
  APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA,
  validateApplicationFieldRepairApprovalArtifact,
  validateApplicationFieldRepairGateArtifact,
  validateApplicationFieldRepairVerificationArtifact,
  type ApplicationFieldRepairArtifactBinding,
} from "./application-field-repair-provenance";

const binding: ApplicationFieldRepairArtifactBinding = {
  releaseKind: "application_field_repair",
  releaseId: "repair-release-1",
  releasePlanSha256: "1".repeat(64),
  manifestSha256: "2".repeat(64),
  grantId: "00000000-0000-4000-8000-000000000001",
  parentPromotionItemId: "00000000-0000-4000-8000-000000000002",
};
const aggregateEvidence = {
  independentReviewManifestSha256: "3".repeat(64),
  independentReviewAggregateSha256: "4".repeat(64),
  readinessSha256: "5".repeat(64),
  candidateCount: 1,
  unresolvedDefects: 0,
};
const aggregate = {
  schema: APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
  ...binding,
  createdAt: "2026-09-11T00:00:00.000Z",
  matchingMutationCount: 0,
  ...aggregateEvidence,
  verdict: "GO",
};

validateApplicationFieldRepairGateArtifact({
  value: aggregate,
  binding,
  expectation: {
    schema: APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
    verdict: "GO",
    evidence: aggregateEvidence,
  },
});
assert.throws(
  () => validateApplicationFieldRepairGateArtifact({
    value: { ...aggregate, independentReviewAggregateSha256: "6".repeat(64) },
    binding,
    expectation: {
      schema: APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
      verdict: "GO",
      evidence: aggregateEvidence,
    },
  }),
  /gate evidence/u,
  "다른 독립검수 aggregate를 재사용할 수 없다",
);

const gateSha256s = {
  aggregateSha256: "6".repeat(64),
  shadowSha256: "7".repeat(64),
  dryRunSha256: "8".repeat(64),
};
const approvedAt = new Date("2026-09-11T00:10:00.000Z");
const approval = {
  schema: APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA,
  releaseKind: binding.releaseKind,
  releaseId: binding.releaseId,
  releasePlanSha256: binding.releasePlanSha256,
  manifestSha256: binding.manifestSha256,
  ...gateSha256s,
  approvedBy: "reviewer",
  approvedAt: approvedAt.toISOString(),
};
const ledger = {
  status: "approved",
  approvedBy: "reviewer",
  approvedAt,
  approvalArtifactSha256: "9".repeat(64),
  gateSummary: gateSha256s,
};

validateApplicationFieldRepairApprovalArtifact({
  value: approval,
  artifactSha256: ledger.approvalArtifactSha256,
  binding,
  ledger,
  gateSha256s,
  executingActor: "executor",
});
for (const corrupted of [
  { artifactSha256: "0".repeat(64), gateSha256s },
  { artifactSha256: ledger.approvalArtifactSha256, gateSha256s: { ...gateSha256s, dryRunSha256: "0".repeat(64) } },
]) {
  assert.throws(
    () => validateApplicationFieldRepairApprovalArtifact({
      value: approval,
      binding,
      ledger,
      executingActor: "executor",
      ...corrupted,
    }),
    /provenance/u,
    "approval 파일이나 gate hash가 바뀌면 write를 닫는다",
  );
}
assert.throws(
  () => validateApplicationFieldRepairApprovalArtifact({
    value: approval,
    artifactSha256: ledger.approvalArtifactSha256,
    binding,
    ledger,
    gateSha256s,
    executingActor: "reviewer",
  }),
  /승인자와 실행자/u,
);

const verification = {
  schema: APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA,
  ...binding,
  createdAt: "2026-09-11T00:20:00.000Z",
  scope: "canary",
  attempt: 2,
  expectedFieldCount: 16,
  currentServingStateSha256: "a".repeat(64),
  reasons: [],
  verdict: "PASS",
};
validateApplicationFieldRepairVerificationArtifact({
  value: verification,
  binding,
  scope: "canary",
  attempt: 2,
  expectedFieldCount: 16,
  verdict: "PASS",
  expectedServingStateSha256: "a".repeat(64),
});
assert.throws(
  () => validateApplicationFieldRepairVerificationArtifact({
    value: { ...verification, currentServingStateSha256: "b".repeat(64) },
    binding,
    scope: "canary",
    attempt: 2,
    expectedFieldCount: 16,
    verdict: "PASS",
    expectedServingStateSha256: "a".repeat(64),
  }),
  /verification receipt provenance/u,
  "activation은 repair ledger와 다른 serving state를 검증한 receipt를 받지 않는다",
);

console.log("application field repair provenance: ok");
