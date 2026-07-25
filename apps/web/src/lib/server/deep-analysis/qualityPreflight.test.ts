import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  DeepAnalysisQualityCohortEntry,
  DeepAnalysisQualityPublicManifest,
  DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";
import { buildDeepAnalysisQualitySourceContentSha256 } from "./qualityCohort";
import {
  buildDeepAnalysisQualityPreflightReceipt,
  planDeepAnalysisQualityLogicalCalls,
  verifyDeepAnalysisQualityPreflightReceipt,
  type DeepAnalysisQualityPreflightObservation,
} from "./qualityPreflight";

const frozenEntries = Array.from({ length: 80 }, (_, index) => frozenEntry(index));
const frozenPublicManifest = {
  manifestSha256: hash("frozen-public"),
  selectionCommitmentSha256: hash("selection"),
} as DeepAnalysisQualityPublicManifest;
const frozenSecretManifest = {
  manifestSha256: hash("frozen-secret"),
  selected: frozenEntries,
} as DeepAnalysisQualitySecretManifest;
const observations = frozenEntries.map(observation);
const frozenSourceContentSha256 = buildDeepAnalysisQualitySourceContentSha256({
  rawPayloadSha256: frozenEntries[0]!.rawPayloadSha256,
  attachmentSummary: frozenEntries[0]!.attachmentSummary,
});
assert.equal(
  buildDeepAnalysisQualitySourceContentSha256({
    rawPayloadSha256: frozenEntries[0]!.rawPayloadSha256,
    attachmentSummary: {
      ...frozenEntries[0]!.attachmentSummary,
      stableArchiveCount: 0,
      convertedCount: 0,
      contentBoundLoadableCount: 0,
    },
  }),
  frozenSourceContentSha256,
  "archive/conversion preparation enrichment must not change source content identity",
);
assert.notEqual(
  buildDeepAnalysisQualitySourceContentSha256({
    rawPayloadSha256: frozenEntries[0]!.rawPayloadSha256,
    attachmentSummary: {
      ...frozenEntries[0]!.attachmentSummary,
      declaredCount: 2,
    },
  }),
  frozenSourceContentSha256,
  "attachment inventory changes must change source content identity",
);

assert.deepEqual(
  planDeepAnalysisQualityLogicalCalls({
    readyForExecution: true,
    evidenceChars: 140_001,
    chunkCount: 3,
  }),
  {
    basePassesPerAnalysis: 4,
    mandatoryLogicalModelCalls: 8,
    maxLogicalModelCalls: 13,
    maxHttpAttemptsWithOneRetryPerCall: 26,
  },
);

const ready = buildDeepAnalysisQualityPreflightReceipt({
  generatedAt: "2026-07-25T03:00:00.000Z",
  frozenPublicManifest,
  frozenSecretManifest,
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  observations,
});
assert.equal(ready.inputReadinessVerdict, "PASS");
assert.equal(ready.qualityVerdict, "NOT_RUN");
assert.equal(ready.summary.readyForExecutionCount, 80);
assert.equal(ready.summary.sourceContentMatchCount, 80);
assert.equal(ready.summary.mandatoryLogicalModelCalls, 160);
assert.equal(ready.summary.maxLogicalModelCalls, 560);
assert.equal(ready.policy.cohortPerNoticeCapUpperBoundUsd, 160);
assert.equal(ready.externalLlmCalls, 0);
assert.equal(ready.databaseWriteMode, false);
assert.equal(ready.objectStorageWriteMode, false);
verifyDeepAnalysisQualityPreflightReceipt({
  frozenPublicManifest,
  frozenSecretManifest,
  receipt: ready,
});

const preparationEnriched = buildDeepAnalysisQualityPreflightReceipt({
  generatedAt: "2026-07-25T03:00:30.000Z",
  frozenPublicManifest,
  frozenSecretManifest,
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  observations: observations.map((item, index) => index === 0
    ? {
      ...item,
      frozenSnapshotMatched: false,
      observedSelectorRevisionSha256: hash("prepared-selector"),
      snapshotDriftCodes: [
        "frozen_attachment_summary_changed",
        "frozen_selector_revision_changed",
      ],
    }
    : item),
});
assert.equal(preparationEnriched.inputReadinessVerdict, "PASS");
assert.equal(preparationEnriched.summary.readyForExecutionCount, 80);
assert.equal(
  preparationEnriched.summary.snapshotDriftCounts.frozen_attachment_summary_changed,
  1,
);
assert.equal(
  preparationEnriched.summary.snapshotDriftCounts.frozen_selector_revision_changed,
  1,
);

const json = JSON.stringify(ready);
for (const entry of frozenEntries.filter((item) => item.split === "sealed")) {
  assert.equal(json.includes(entry.sourceId), false);
  assert.equal(json.includes(entry.canonicalId), false);
}

const blocked = buildDeepAnalysisQualityPreflightReceipt({
  generatedAt: "2026-07-25T03:01:00.000Z",
  frozenPublicManifest,
  frozenSecretManifest,
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  observations: observations.map((item, index) => index === 0
    ? {
      ...item,
      currentInputSealed: false,
      blockerCodes: ["production_input_not_sealed"],
      productionBlockerCodes: ["blocked_conversion"],
    }
    : item),
});
assert.equal(blocked.inputReadinessVerdict, "BLOCKED");
assert.equal(blocked.summary.readyForExecutionCount, 79);
assert.equal(blocked.summary.blockerCounts.production_input_not_sealed, 1);
assert.equal(blocked.summary.productionBlockerCounts.blocked_conversion, 1);
assert.equal(blocked.summary.mandatoryLogicalModelCalls, 158);
assert.equal(
  blocked.items.find(
    (item) => item.opaqueCommitmentSha256 === frozenEntries[0]!.opaqueCommitmentSha256,
  )!.callPlan.maxLogicalModelCalls,
  0,
);

const sourceChanged = buildDeepAnalysisQualityPreflightReceipt({
  generatedAt: "2026-07-25T03:02:00.000Z",
  frozenPublicManifest,
  frozenSecretManifest,
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  observations: observations.map((item, index) => index === 0
    ? {
      ...item,
      frozenSnapshotMatched: false,
      sourceContentMatched: false,
      observedSourceContentSha256: hash("changed-source-content"),
      blockerCodes: ["frozen_source_content_changed"],
    }
    : item),
});
assert.equal(sourceChanged.inputReadinessVerdict, "BLOCKED");
assert.equal(sourceChanged.summary.readyForExecutionCount, 79);
assert.equal(sourceChanged.summary.sourceContentMatchCount, 79);
assert.equal(sourceChanged.summary.blockerCounts.frozen_source_content_changed, 1);

const tampered = structuredClone(ready);
tampered.items[0]!.readyForExecution = false;
assert.throws(
  () => verifyDeepAnalysisQualityPreflightReceipt({
    frozenPublicManifest,
    frozenSecretManifest,
    receipt: tampered,
  }),
  /envelope\/hash is invalid/,
);

console.log("deep-analysis quality preflight tests passed");

function frozenEntry(index: number): DeepAnalysisQualityCohortEntry {
  const source = index < 40 ? "kstartup" : "bizinfo";
  const sourceId = `${source}-preflight-${index}`;
  return {
    source,
    sourceId,
    canonicalId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    title: `Preflight ${index}`,
    status: "open",
    applyStart: "2026-07-01",
    applyEnd: "2026-08-31",
    rawPayloadSha256: hash(`raw-${index}`),
    attachmentSummary: {
      schemaVersion: "grant-analysis-attachment-summary-v1",
      declaredKnown: true,
      declaredCount: 1,
      presentCount: 1,
      expectedCount: 1,
      inventoryIncomplete: false,
      stableArchiveCount: 1,
      convertedCount: 1,
      contentBoundLoadableCount: 1,
      skippedCount: 0,
      failedCount: 0,
      artifacts: [],
      attachmentSummarySha256: hash(`attachment-${index}`),
    },
    sourceRevisionSha256: hash(`selector-${index}`),
    baselineCriteriaCount: 0,
    baselineExclusionCount: 0,
    coverageTags: [],
    requiredRecovery: false,
    split: index % 5 < 3 ? "validation" : "sealed",
    selectorRankSha256: hash(`rank-${index}`),
    opaqueCommitmentSha256: hash(`commitment-${index}`),
  };
}

function observation(
  entry: DeepAnalysisQualityCohortEntry,
): DeepAnalysisQualityPreflightObservation {
  return {
    source: entry.source,
    sourceId: entry.sourceId,
    canonicalId: entry.canonicalId,
    opaqueCommitmentSha256: entry.opaqueCommitmentSha256,
    split: entry.split,
    frozenSnapshotMatched: true,
    sourceContentMatched: true,
    frozenSourceContentSha256: buildDeepAnalysisQualitySourceContentSha256({
      rawPayloadSha256: entry.rawPayloadSha256,
      attachmentSummary: entry.attachmentSummary,
    }),
    observedSourceContentSha256: buildDeepAnalysisQualitySourceContentSha256({
      rawPayloadSha256: entry.rawPayloadSha256,
      attachmentSummary: entry.attachmentSummary,
    }),
    observedSelectorRevisionSha256: entry.sourceRevisionSha256,
    productionSourceRevisionSha256: hash(`production-${entry.sourceId}`),
    attachmentManifestSha256: hash(`manifest-${entry.sourceId}`),
    inputSha256: hash(`input-${entry.sourceId}`),
    currentInputSealed: true,
    totalChars: 1_000,
    evidenceChars: 1_100,
    attachmentCount: 1,
    includedAttachmentCount: 1,
    chunkCount: 1,
    dispositionCounts: { included: 1 },
    snapshotDriftCodes: [],
    blockerCodes: [],
    productionBlockerCodes: [],
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
