import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stableJson } from "../deep-analysis/sourceRevision";
import { parseMatchingPdfRecoveryPlan } from "./matching-pdf-source-recovery-cli";

const sha = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const digest = "a".repeat(64);
const target = {
  grantId: "11111111-1111-4111-8111-111111111111",
  source: "bizinfo",
  sourceId: "PBLN_1",
  applyEnd: "2026-10-01T00:00:00.000Z",
  inputSha256: digest,
  attachmentManifestSha256: digest,
  missingPdfFiles: ["공고문.pdf"],
};
const pdf = {
  grantId: target.grantId,
  sourceId: target.sourceId,
  surfaceId: "22222222-2222-4222-8222-222222222222",
  sourceAttachment: "grant-archive/original.pdf",
  pdfStorageKey: "grant-archive/original.pdf",
  pdfSha256: digest,
  title: "공고문.pdf",
};

function plan(payloadOverrides: Record<string, unknown> = {}) {
  const payload = {
    schema: "matching-pdf-source-recovery-plan-v1",
    preparedAt: "2026-09-28T00:00:00.000Z",
    sourceManifestSha256: digest,
    mode: "source-recovery-only",
    modelCalls: 0,
    servicePromotion: false,
    objectStorageWrite: true,
    databaseWrite: true,
    targetCount: 1,
    pdfCount: 1,
    targets: [target],
    pdfs: [pdf],
    ...payloadOverrides,
  };
  return { ...payload, planSha256: sha(payload) };
}

test("exact PDF recovery plan accepts a bound source-only batch", () => {
  assert.equal(parseMatchingPdfRecoveryPlan(plan()).targetCount, 1);
});

test("tampered plan bytes and widened execution scope are rejected", () => {
  assert.throws(() => parseMatchingPdfRecoveryPlan({ ...plan(), modelCalls: 1 }), /SHA mismatch/);
  assert.throws(() => parseMatchingPdfRecoveryPlan(plan({ modelCalls: 1 })), /contract mismatch/);
  assert.throws(() => parseMatchingPdfRecoveryPlan(plan({ servicePromotion: true })), /contract mismatch/);
});

test("candidate identity cannot drift from the target's missing PDF", () => {
  assert.throws(() => parseMatchingPdfRecoveryPlan(plan({
    pdfs: [{ ...pdf, title: "다른공고.pdf" }],
  })), /target files mismatch/);
  assert.throws(() => parseMatchingPdfRecoveryPlan(plan({
    pdfs: [pdf, { ...pdf, title: "공고문.pdf" }],
    pdfCount: 2,
    targets: [{ ...target, missingPdfFiles: ["공고문.pdf", "공고문.pdf"] }],
  })), /target binding mismatch/);
});
