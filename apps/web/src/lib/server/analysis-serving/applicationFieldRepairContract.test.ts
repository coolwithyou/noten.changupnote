import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL, APPLICATION_ROUNDTRIP_VERSION } from "../application-analysis/contract";
import {
  createApplicationFieldRepairReleaseManifest,
  resolveApplicationFieldRepairAuthoringReadiness,
  validateApplicationFieldRepairReleaseManifest,
  type ApplicationFieldRepairServingRow,
} from "./applicationFieldRepairContract";
import { sha256Canonical, type PromotionSourceArtifact } from "./promotionReleaseContract";
import {
  applicationFieldRepairServingStateSha256,
  applicationFieldRepairSnapshotSha256,
  type ApplicationFieldRepairSnapshot,
} from "./applicationFieldRepairSnapshot";

const grantId = "11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const releaseDbId = "33333333-3333-4333-8333-333333333333";
const H = (value: string) => sha256Canonical(value);

function fixture(version = APPLICATION_ROUNDTRIP_VERSION) {
  const releaseId = "application-field-repair-contract-r1";
  const launchReceiptSha256 = H("launch-receipt");
  const launchManifestSha256 = H("launch-manifest");
  const aggregateSha256 = H("aggregate");
  const attachmentSha256 = H("attachments");
  const sourceSha256 = H("source");
  const inputSha256 = H("input");
  const runSha256 = H("run");
  const roundtripRunId = "roundtrip-current-contract";
  const runId = "run-current-contract";
  const sourceArtifact = {
    grantId,
    runId,
    runSha256,
    overlaySha256: null,
    confirmationsSha256: null,
    sourceRevisionSha256: sourceSha256,
    localLabEvidence: {
      schema: "verified-local-lab-source-v1",
      transport: "claude-cli",
      model: "claude-opus-5",
      promptVersion: "test-v1",
      inputSha256,
      reviewMethod: "analysis_launch_independent_review",
      analysisLaunch: {
        schema: "verified-analysis-launch-source-v1",
        launchReceiptSha256,
        launchManifestSha256,
        launchGrantSha256: H("grant"),
        launchSequence: 0,
        independentReviewManifestSha256: H("review-manifest"),
        independentReviewAggregateSha256: aggregateSha256,
        attachmentManifestSha256: attachmentSha256,
        sourceRevisionSha256: sourceSha256,
        executionGitSha: "a".repeat(40),
        packageRuntimeSha256: H("runtime"),
        validatorVersion: "validator-v1",
        applicationFieldAnalysisVersion: version,
      },
    },
    applicationPrecompute: {
      schema: "promotion-application-precompute-v3",
      releaseId,
      grantId,
      parentLabRunId: runId,
      roundtripRunId,
      status: "conditional",
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      analysisSha256: runSha256,
      manifestSha256: H("roundtrip-manifest"),
      sourceCount: 2,
      documentCount: 2,
      materializableDocumentCount: 1,
      reviewRequiredDocumentCount: 0,
      launchAdmission: {
        launchReceiptSha256,
        launchManifestSha256,
        launchGrantSha256: H("grant"),
        launchSequence: 0,
        independentReviewManifestSha256: H("review-manifest"),
        independentReviewAggregateSha256: aggregateSha256,
        runArtifactSha256: runSha256,
        applicationFieldAnalysisVersion: version,
      },
    },
  } satisfies PromotionSourceArtifact;
  const manifest = createApplicationFieldRepairReleaseManifest({
    releaseId,
    revision: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    gitCommit: "b".repeat(40),
    buildDigest: H("build"),
    cohortLabel: "contract-test",
    repair: {
      grantId,
      parent: {
        releaseDbId,
        releaseId: "parent-release",
        releaseManifestSha256: H("parent-manifest"),
        releasePlanSha256: H("parent-release-plan"),
        promotionItemId: parentId,
        runId: "parent-run",
        planSha256: H("parent-plan"),
        afterSha256: H("parent-after"),
        appliedAt: "2026-09-10T00:00:00.000Z",
      },
      inventory: {
        policy: "open-visible-current-period-missing-fields-v1",
        seriesId: "current-field-repair-contract-test",
        inventorySha256: H("inventory"),
        launchManifestSha256,
        launchReceiptSha256,
      },
      sourceArtifact,
      readiness: {
        schema: "analysis-launch-promotion-readiness-v1",
        disposition: "conditional",
        reasons: [],
        unresolvedAxes: [],
        sourceRevisionSha256: sourceSha256,
        inputSha256,
        attachmentManifestSha256: attachmentSha256,
        launchReceiptSha256,
        independentReviewAggregateSha256: aggregateSha256,
        applicationRoundtripStatus: "partial",
        applicationRoundtripRunId: roundtripRunId,
        applicationDocumentCount: 1,
        fieldReadyDocumentCount: 1,
        recognizedFieldCount: 16,
        runFeatureReadiness: {
          schema: "analysis-feature-readiness-v1",
          matching: { status: "ready", sourceDisposition: "conditional", reasons: [] },
          authoring: { status: "ready", sourceDisposition: "ready", reasons: [] },
        },
        runFeatureReadinessVerification: "verified",
        authoringEvidenceStatus: "verified",
        authoringEvidenceReasons: [],
      },
      beforeApplicationSnapshotSha256: H("before-app"),
      fieldCountBefore: 0,
      expectedFieldCount: 16,
      expectedMaterializableSurfaceCount: 1,
      materializationPlanSha256: H("materialization-plan"),
    },
  });
  const receipt = {
    schema: "analysis-lab-application-precompute-receipt-v1",
    status: "conditional",
    roundtripRunId,
    transport: "claude-cli",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    analysisSha256: runSha256,
    manifestSha256: sourceArtifact.applicationPrecompute.manifestSha256,
    materialized: 1,
    reused: 0,
    protected: 0,
    terminalOnly: 1,
    fields: 16,
    completedAt: "2026-09-11T00:01:00.000Z",
  };
  return { manifest, receipt, roundtripRunId };
}

test("current contract의 applied repair만 authoring ready를 제공한다", () => {
  const { manifest, receipt, roundtripRunId } = fixture();
  assert.equal(validateApplicationFieldRepairReleaseManifest(manifest).manifestSha256, manifest.manifestSha256);
  const row: ApplicationFieldRepairServingRow = {
    repairId: "repair-1",
    releaseDbId,
    releaseId: manifest.releaseId,
    releaseStatus: "active",
    releaseManifestSha256: manifest.manifestSha256,
    releaseManifest: manifest,
    grantId,
    parentPromotionItemId: parentId,
    roundtripRunId,
    applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
    planSha256: manifest.repair.planSha256,
    status: "applied",
    applicationPrecomputeReceipt: receipt,
    servingStateSha256: H("serving"),
    currentServingStateSha256: H("serving"),
    appliedAt: new Date("2026-09-11T00:01:00.000Z"),
  };
  assert.deepEqual(resolveApplicationFieldRepairAuthoringReadiness(row), {
    status: "ready",
    sourceDisposition: "ready",
  });
  for (const broken of [
    { ...row, status: "prepared" },
    { ...row, releaseStatus: "canary_passed" },
    { ...row, releaseStatus: "failed" },
    { ...row, currentServingStateSha256: H("drift") },
    { ...row, applicationPrecomputeReceipt: { ...receipt, fields: 15 } },
    { ...row, applicationFieldAnalysisVersion: "application-roundtrip-v10" },
  ]) {
    assert.equal(resolveApplicationFieldRepairAuthoringReadiness(broken), null);
  }
});

test("구 application 분석 version으로 새 repair manifest를 만들 수 없다", () => {
  assert.throws(
    () => validateApplicationFieldRepairReleaseManifest(fixture("application-roundtrip-v10").manifest),
    /exact 결속/u,
  );
});

test("draft 변화는 serving hash에서 제외하고 full transaction digest에는 남긴다", () => {
  const snapshot: ApplicationFieldRepairSnapshot = {
    schema: "analysis-lab-application-field-repair-snapshot-v1",
    grantId,
    surfaces: [],
    fields: [],
    drafts: [{
      id: "draft-1",
      surfaceId: null,
      updatedAt: "2026-09-11T00:00:00.000Z",
      stateSha256: H("draft-before"),
    }],
  };
  const changed = {
    ...snapshot,
    drafts: [{ ...snapshot.drafts[0]!, stateSha256: H("draft-after") }],
  };
  assert.equal(
    applicationFieldRepairServingStateSha256(changed),
    applicationFieldRepairServingStateSha256(snapshot),
  );
  assert.notEqual(
    applicationFieldRepairSnapshotSha256(changed),
    applicationFieldRepairSnapshotSha256(snapshot),
  );
});
