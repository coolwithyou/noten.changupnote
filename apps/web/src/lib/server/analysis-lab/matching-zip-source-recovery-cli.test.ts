import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stableJson } from "../deep-analysis/sourceRevision";
import { parseMatchingZipRecoveryPlan } from "./matching-zip-source-recovery-cli";

const digest = "a".repeat(64);
const sha = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");

function plan(overrides: Record<string, unknown> = {}) {
  const payload = {
    schema: "matching-zip-source-recovery-plan-v2",
    preparedAt: "2026-09-28T00:00:00.000Z",
    sourceManifestSha256: digest,
    mode: "source-recovery-with-match-refresh",
    grantId: "11111111-1111-4111-8111-111111111111",
    source: "bizinfo",
    sourceId: "PBLN_1",
    applyEnd: "2026-10-01T00:00:00.000Z",
    inputSha256: digest,
    attachmentManifestSha256: digest,
    filename: "첨부파일.zip",
    sourceUri: "https://example.com/source.zip",
    originalSha256: digest,
    originalBytes: 1234,
    maxOriginalAttachments: 1,
    expectedMaterialChildren: 5,
    imageOcr: "macos_vision",
    modelCalls: 0,
    servicePromotion: false,
    grantPublication: true,
    matchStateRefresh: true,
    maxAffectedGrants: 1,
    maxExistingMatchStateRows: 1,
    matchCompanyIdsSha256: digest,
    criterionCount: 11,
    promotedCriterionCount: 0,
    databaseWrite: true,
    objectStorageWrite: true,
    ...overrides,
  };
  return { ...payload, planSha256: sha(payload) };
}

test("one exact ZIP source recovery plan is accepted", () => {
  assert.equal(parseMatchingZipRecoveryPlan(plan()).expectedMaterialChildren, 5);
});

test("tampering or widening the source write plan is rejected", () => {
  assert.throws(() => parseMatchingZipRecoveryPlan({ ...plan(), sourceId: "PBLN_2" }), /SHA mismatch/);
  assert.throws(() => parseMatchingZipRecoveryPlan(plan({ maxOriginalAttachments: 2 })), /contract mismatch/);
  assert.throws(() => parseMatchingZipRecoveryPlan(plan({ modelCalls: 1 })), /contract mismatch/);
  assert.throws(() => parseMatchingZipRecoveryPlan(plan({ imageOcr: "none" })), /contract mismatch/);
  assert.throws(() => parseMatchingZipRecoveryPlan(plan({ matchStateRefresh: false })), /contract mismatch/);
  assert.throws(() => parseMatchingZipRecoveryPlan(plan({ sourceUri: "http://example.com/source.zip" })), /contract mismatch/);
});
