import assert from "node:assert/strict";
import type { PromotionApplicationPrecomputeEvidence } from "../analysis-serving/applicationPrecomputeEvidence";
import {
  ANALYSIS_LAUNCH_PROMOTION_READINESS_SCHEMA,
  isStrictTerminalNotApplicableApplicationPrecompute,
  type AnalysisLaunchPromotionReadiness,
} from "./analysis-launch-promotion";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";

const roundtripRunId = "roundtrip-2026-09-02T103758.910Z-b9d1aa";
const readiness: AnalysisLaunchPromotionReadiness = {
  schema: ANALYSIS_LAUNCH_PROMOTION_READINESS_SCHEMA,
  disposition: "conditional",
  reasons: [],
  unresolvedAxes: [{ dimension: "size", status: "ambiguous" }],
  sourceRevisionSha256: "1".repeat(64),
  inputSha256: "2".repeat(64),
  attachmentManifestSha256: "3".repeat(64),
  launchReceiptSha256: "4".repeat(64),
  independentReviewAggregateSha256: "5".repeat(64),
  applicationRoundtripStatus: "not_applicable",
  applicationRoundtripRunId: roundtripRunId,
  applicationDocumentCount: 0,
  fieldReadyDocumentCount: 0,
  recognizedFieldCount: 0,
  runFeatureReadiness: {
    schema: "analysis-feature-readiness-v1",
    matching: { status: "ready", sourceDisposition: "conditional", reasons: [] },
    authoring: {
      status: "held",
      sourceDisposition: "not_applicable",
      reasons: ["application_field_analysis_not_applicable"],
    },
  },
  runFeatureReadinessVerification: "derived_legacy",
  authoringEvidenceStatus: "verified",
  authoringEvidenceReasons: [],
  primaryMatchingProjectionStatus: "unverified",
  primaryMatchingProjectionSnapshotSha256: null,
};
const evidence: PromotionApplicationPrecomputeEvidence = {
  schema: "promotion-application-precompute-v3",
  releaseId: "release-not-applicable-test",
  grantId: "00000000-0000-4000-8000-000000000001",
  parentLabRunId: "run-not-applicable-test",
  roundtripRunId,
  status: "not_applicable",
  transport: "claude-cli",
  model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  analysisSha256: "6".repeat(64),
  manifestSha256: "7".repeat(64),
  sourceCount: 1,
  documentCount: 1,
  materializableDocumentCount: 0,
  reviewRequiredDocumentCount: 0,
  launchAdmission: {
    launchReceiptSha256: "4".repeat(64),
    launchManifestSha256: "8".repeat(64),
    launchGrantSha256: "9".repeat(64),
    launchSequence: 0,
    independentReviewManifestSha256: "a".repeat(64),
    independentReviewAggregateSha256: "5".repeat(64),
    runArtifactSha256: "b".repeat(64),
    applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
  },
};
const run = {
  runId: roundtripRunId,
  sourceCount: 1,
  documents: [{ role: "announcement" }],
  error: null,
  failureCode: null,
};

const accepted = () => isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence,
  run,
});
assert.equal(accepted(), true, "정확히 닫힌 legacy not_applicable bundle만 읽기 재검증에서 보존합니다");

const rejectedCases: AnalysisLaunchPromotionReadiness[] = [
  { ...readiness, applicationRoundtripStatus: "partial" as const },
  { ...readiness, runFeatureReadinessVerification: "verified" as const },
  { ...readiness, applicationDocumentCount: 1 },
  { ...readiness, fieldReadyDocumentCount: 1 },
  { ...readiness, recognizedFieldCount: 1 },
  { ...readiness, authoringEvidenceStatus: "held" as const, authoringEvidenceReasons: ["binding"] },
  {
    ...readiness,
    runFeatureReadiness: {
      ...readiness.runFeatureReadiness,
      authoring: {
        status: "held",
        sourceDisposition: "held",
        reasons: ["application_field_analysis_held"],
      },
    },
  },
];
for (const changed of rejectedCases) {
  assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
    readiness: changed,
    evidence,
    run,
  }), false);
}
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, schema: "promotion-application-precompute-v2" },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, status: "conditional" },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, materializableDocumentCount: 1 },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, reviewRequiredDocumentCount: 1 },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, documentCount: 2 },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, sourceCount: 2 },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence,
  run: { ...run, sourceCount: 2 },
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence: { ...evidence, roundtripRunId: "roundtrip-other" },
  run,
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence,
  run: { ...run, documents: [{ role: "application_form" }] },
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence,
  run: { ...run, error: "failed" },
}), false);
assert.equal(isStrictTerminalNotApplicableApplicationPrecompute({
  readiness,
  evidence,
  run: { ...run, failureCode: "document_analysis_failed" },
}), false);

assert.equal(readiness.runFeatureReadiness.authoring.status, "held");
assert.equal(readiness.runFeatureReadiness.authoring.sourceDisposition, "not_applicable");
console.log("analysis launch terminal not-applicable tests: ok");
