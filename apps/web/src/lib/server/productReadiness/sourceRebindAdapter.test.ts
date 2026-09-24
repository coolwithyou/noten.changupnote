import assert from "node:assert/strict";
import test from "node:test";
import { createGrantNextWorkSnapshot } from "./grantNextWorkExecution";
import {
  bindSourceRebindRelease,
  createSourceRebindAdapter,
  type ApprovedSourceRebindRelease,
  type SourceRebindReleasePort,
} from "./sourceRebindAdapter";
import {
  createSourceRebindReleaseManifest,
  type SourceRebindReleaseManifest,
} from "./sourceRebindRelease";
import type { GrantSourceChangeImpact } from "../ingestion/grantSourceChangeImpact";

const GRANT_ID = "00000000-0000-4000-8000-000000000901";
const PARENT_ID = "00000000-0000-4000-8000-000000000902";
const QUESTION_ID = "00000000-0000-4000-8000-000000000903";
const CRITERION_ID = "00000000-0000-4000-8000-000000000904";
const PREVIOUS_REVISION = "a".repeat(64);
const PREVIOUS_RAW = "b".repeat(64);
const CURRENT_REVISION = "c".repeat(64);
const CURRENT_RAW = "d".repeat(64);
const CURRENT_MATERIAL = "e".repeat(64);

function impact(classification: GrantSourceChangeImpact["classification"] = "evidence_refresh"): GrantSourceChangeImpact {
  return {
    schema: "grant-source-change-impact-v2",
    classification,
    changedDomains: classification === "evidence_refresh" ? ["raw"] : ["raw", "coverage"],
    previousRawSha256: PREVIOUS_RAW,
    currentRawSha256: CURRENT_RAW,
    requiresModelRun: false,
  };
}

function snapshot(changeImpact = impact()) {
  return createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    sourceChangeImpact: changeImpact,
    readinessInput: {
      grantId: GRANT_ID,
      source: {
        availability: "available",
        revisionSha256: CURRENT_REVISION,
        rawSha256: CURRENT_RAW,
        materialRevisionSha256: CURRENT_MATERIAL,
        attachmentStatus: "not_required",
        attachmentManifestSha256: null,
      },
      analysis: {
        status: "present",
        sourceRevisionSha256: PREVIOUS_REVISION,
        sourceRawSha256: CURRENT_RAW,
        attachmentManifestSha256: null,
        structure: "complete",
        criteriaReview: "reviewed",
        eligibleQuestionCriterionStableKeys: ["criterion:location"],
      },
      questions: [{
        criterionStableKey: "criterion:location",
        evaluationContractVersion: "confirmation-evaluation-v2",
        reviewed: false,
        invalidated: false,
        sourceRevisionSha256: PREVIOUS_REVISION,
        sourceRawSha256: PREVIOUS_RAW,
      }],
    },
  });
}

function manifest(changeImpact = impact()): SourceRebindReleaseManifest {
  return createSourceRebindReleaseManifest({
    releaseId: "source-rebind-fixture",
    gitCommit: "fixture-commit",
    buildDigest: "fixture-build",
    material: {
      grantId: GRANT_ID,
      parent: {
        promotionItemId: PARENT_ID,
        runId: "fixture-run",
        afterSha256: "1".repeat(64),
        currentServingStateSha256: "2".repeat(64),
        rootSourceRevisionSha256: PREVIOUS_REVISION,
        sourceRevisionSha256: PREVIOUS_REVISION,
      },
      source: {
        previousRawSha256: PREVIOUS_RAW,
        currentRawSha256: CURRENT_RAW,
        currentRevisionSha256: CURRENT_REVISION,
        currentMaterialRevisionSha256: CURRENT_MATERIAL,
      },
      sourceChangeImpact: changeImpact,
      questions: [{
        questionId: QUESTION_ID,
        criterionId: CRITERION_ID,
        questionVersion: 1,
        beforeDefinitionSha256: "3".repeat(64),
        afterDefinitionSha256: "4".repeat(64),
        answerCount: 1,
      }],
    },
  });
}

function approved(value = manifest()): ApprovedSourceRebindRelease {
  return {
    status: "approved",
    manifest: value,
    approvedBy: "source-reviewer",
    approvedAt: "2026-09-22T12:00:00.000Z",
    approvalArtifactSha256: "5".repeat(64),
  };
}

test("evidence refresh와 current material source가 exact하면 승인 successor를 적용한다", async () => {
  const current = snapshot();
  assert.equal(current.nextWork.action, "source_rebind");
  const releaseManifest = manifest();
  let applied = 0;
  const port: SourceRebindReleasePort = {
    loadApprovedRelease: async () => approved(releaseManifest),
    applyApprovedRelease: async (binding) => {
      applied += 1;
      assert.equal(binding.expectedEvidenceSha256, current.evidenceSha256);
      return {
        servingStateSha256: "6".repeat(64),
        reboundQuestionCount: 1,
        reboundAnswerCount: 1,
        replayed: false,
      };
    },
  };
  const adapter = createSourceRebindAdapter({
    releaseId: releaseManifest.releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "source-executor",
    port,
  });
  const receipt = await adapter.execute({
    grantId: GRANT_ID,
    expectedEvidenceSha256: current.evidenceSha256,
    snapshot: current,
  });
  assert.equal(applied, 1);
  assert.equal(receipt.action, "source_rebind");
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.externalWrites, 1);
});

test("coverage 변화와 material source drift는 writer admission 전에 닫는다", () => {
  const coverageImpact = impact("coverage_review_required");
  const coverageSnapshot = snapshot(coverageImpact);
  assert.equal(coverageSnapshot.nextWork.action, "coverage_review");
  const current = snapshot();
  const releaseManifest = manifest();
  assert.throws(() => bindSourceRebindRelease({
    releaseId: releaseManifest.releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "source-executor",
    release: approved(releaseManifest),
    snapshot: {
      ...current,
      readinessInput: {
        ...current.readinessInput,
        source: { ...current.readinessInput.source, materialRevisionSha256: "7".repeat(64) },
      },
    },
  }), /source_rebind_snapshot_binding_mismatch/u);
});

test("승인자와 실행자가 같으면 적용하지 않는다", () => {
  const current = snapshot();
  const releaseManifest = manifest();
  assert.throws(() => bindSourceRebindRelease({
    releaseId: releaseManifest.releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "source-reviewer",
    release: approved(releaseManifest),
    snapshot: current,
  }), /source_rebind_actor_separation_required/u);
});

console.log("source rebind adapter: exact evidence refresh admission fixtures passed");
