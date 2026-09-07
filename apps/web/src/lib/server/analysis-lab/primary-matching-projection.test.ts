import assert from "node:assert/strict";
import type { LabCriterion } from "./lab-contract";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  buildPrimaryMatchingProjectionSnapshot,
  capturePrimaryMatchingProjectionSnapshot,
  inspectPrimaryMatchingProjectionSnapshot,
  primaryProjectionSource,
} from "./primary-matching-projection";

function criterion(input: Partial<LabCriterion> & Pick<
  LabCriterion,
  "dimension" | "kind" | "operator" | "value"
>): LabCriterion {
  return {
    confidence: 0.9,
    sourceSpan: null,
    spanVerified: false,
    note: null,
    ...input,
  };
}

const source = primaryProjectionSource({
  runId: "run-2026-09-07T000000.000Z-primary",
  grantId: "00000000-0000-4000-8000-0000000001c0",
  source: "bizinfo",
  sourceId: "178970",
  inputSha256: "1".repeat(64),
  attachmentManifestSha256: "2".repeat(64),
  criteria: [
    criterion({
      dimension: "biz_age",
      kind: "required",
      operator: "lte",
      value: { max_months: 36 },
      sourceSpan: "업력 조건: 3년미만",
    }),
    criterion({
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "대표자 상근 여부 확인" },
      sourceSpan: "대표자는 상근하여야 한다",
    }),
  ],
});

const snapshot = buildPrimaryMatchingProjectionSnapshot({
  source,
  primaryExtractionAvailable: true,
});
assert.equal(snapshot.verification, "verified");
assert.equal(snapshot.report.inputRows, 2);
assert.equal(snapshot.report.items?.[0]?.criterionIndex, 0);
assert.equal(snapshot.report.items?.[0]?.status, "downgraded");
assert.equal(snapshot.report.items?.[0]?.reason, "exclusive_upper_bound_mismatch");
assert.equal(snapshot.projectedCriteria[0]?.kind, "required");
assert.equal(snapshot.projectedCriteria[0]?.operator, "text_only");
assert.equal(snapshot.projectedCriteria[0]?.needs_review, true);
assert.deepEqual(inspectPrimaryMatchingProjectionSnapshot(source, snapshot), {
  status: "verified",
  issues: [],
});

const binding = buildAnalysisLaunchMatchingProjectionBinding(snapshot);
assert.equal(binding.verification, "verified");
assert.equal(binding.sourceCriteriaSha256, snapshot.source.criteriaSha256);
assert.equal(binding.projectedCriteriaSha256, snapshot.projectedCriteriaSha256);

assert.deepEqual(inspectPrimaryMatchingProjectionSnapshot(source, undefined), {
  status: "unverified",
  issues: ["matching_projection_snapshot_missing"],
}, "역사 snapshot 부재는 PASS가 아닌 unverified");

const sourceDrift = { ...source, inputSha256: "3".repeat(64) };
assert.equal(
  inspectPrimaryMatchingProjectionSnapshot(sourceDrift, snapshot).status,
  "mismatch",
  "원본 input binding drift를 PASS로 읽지 않는다",
);
const runtimeDrift = structuredClone(snapshot);
runtimeDrift.runtime.normalizerContractVersion = "future-normalizer";
assert.equal(inspectPrimaryMatchingProjectionSnapshot(source, runtimeDrift).status, "mismatch");
const reportTamper = structuredClone(snapshot);
reportTamper.report.items![0]!.criterionIndex = 9;
assert.equal(inspectPrimaryMatchingProjectionSnapshot(source, reportTamper).status, "mismatch");
const outputTamper = structuredClone(snapshot);
outputTamper.projectedCriteria[0]!.kind = "preferred";
assert.equal(inspectPrimaryMatchingProjectionSnapshot(source, outputTamper).status, "mismatch");

const failedPrimary = buildPrimaryMatchingProjectionSnapshot({
  source: { ...source, criteria: [] },
  primaryExtractionAvailable: false,
});
assert.equal(failedPrimary.verification, "failed");
assert.equal(
  inspectPrimaryMatchingProjectionSnapshot({ ...source, criteria: [] }, failedPrimary).status,
  "failed",
);

const diagnosticException = capturePrimaryMatchingProjectionSnapshot({
  source,
  primaryExtractionAvailable: true,
}, {
  build: () => {
    throw new Error("synthetic diagnostic failure");
  },
});
assert.equal(diagnosticException.verification, "failed");
assert.match(diagnosticException.issues[0] ?? "", /synthetic diagnostic failure/);
assert.equal(diagnosticException.source.primaryExtractionAvailable, true);
assert.equal(
  inspectPrimaryMatchingProjectionSnapshot(source, diagnosticException).status,
  "failed",
  "진단 예외는 primary extraction을 지우지 않고 별도 failed 상태로 남는다",
);

console.log("primary matching projection tests: ok");
