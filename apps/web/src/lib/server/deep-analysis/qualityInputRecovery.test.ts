import assert from "node:assert/strict";
import type { DeepAnalysisQualityPreflightReceipt } from "./qualityPreflight";
import {
  selectDeepAnalysisQualityInputRecoveryItems,
  selectDeepAnalysisQualityInputRecoveryRound,
} from "./qualityInputRecovery";

type Item = DeepAnalysisQualityPreflightReceipt["items"][number];

const ready = item({ readyForExecution: true, currentInputSealed: true });
const fetchBlocked = item({
  readyForExecution: false,
  currentInputSealed: false,
  blockerCodes: ["production_input_not_sealed"],
  productionBlockerCodes: ["blocked_fetch"],
});
const conversionBlocked = item({
  readyForExecution: false,
  currentInputSealed: false,
  blockerCodes: ["production_input_not_sealed"],
  productionBlockerCodes: ["blocked_conversion"],
});
assert.deepEqual(
  selectDeepAnalysisQualityInputRecoveryItems({
    items: [ready, fetchBlocked, conversionBlocked],
  } as Pick<DeepAnalysisQualityPreflightReceipt, "items">),
  [fetchBlocked, conversionBlocked],
);
assert.throws(
  () => selectDeepAnalysisQualityInputRecoveryItems({
    items: [{
      ...fetchBlocked,
      sourceContentMatched: false,
      blockerCodes: ["frozen_source_content_changed"],
    }],
  } as Pick<DeepAnalysisQualityPreflightReceipt, "items">),
  /refuses frozen source content drift/,
);
assert.throws(
  () => selectDeepAnalysisQualityInputRecoveryItems({
    items: [{
      ...fetchBlocked,
      blockerCodes: ["preflight_error"],
    }],
  } as Pick<DeepAnalysisQualityPreflightReceipt, "items">),
  /unsupported preflight blocker/,
);

const bounded = selectDeepAnalysisQualityInputRecoveryRound([
  ...Array.from({ length: 25 }, () => ({ source: "kstartup" as const })),
  ...Array.from({ length: 31 }, () => ({ source: "bizinfo" as const })),
], 20);
assert.equal(bounded.length, 40);
assert.equal(bounded.filter((entry) => entry.source === "kstartup").length, 20);
assert.equal(bounded.filter((entry) => entry.source === "bizinfo").length, 20);

console.log("deep-analysis quality input recovery tests passed");

function item(overrides: Partial<Item>): Item {
  return {
    source: "kstartup",
    split: "validation",
    opaqueCommitmentSha256: "a".repeat(64),
    frozenSnapshotMatched: true,
    sourceContentMatched: true,
    currentInputSealed: false,
    readyForExecution: false,
    snapshotDriftCodes: [],
    blockerCodes: [],
    productionBlockerCodes: [],
    totalChars: 1,
    evidenceChars: 1,
    attachmentCount: 1,
    includedAttachmentCount: 0,
    chunkCount: 1,
    productionBindingSha256: "b".repeat(64),
    callPlan: {
      basePassesPerAnalysis: 0,
      mandatoryLogicalModelCalls: 0,
      maxLogicalModelCalls: 0,
      maxHttpAttemptsWithOneRetryPerCall: 0,
    },
    ...overrides,
  };
}
