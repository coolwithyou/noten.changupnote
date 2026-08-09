import assert from "node:assert/strict";
import {
  PRODUCT_CANARY_EVIDENCE_SCHEMA,
  evaluateProductCanaryObservation,
  validateProductCanaryEvidence,
  type ProductCanaryEvidence,
} from "./product-canary-evidence";

const node = { status: "passed" as const, summary: "통과", evidence: ["근거 1"] };
const fixture: ProductCanaryEvidence = {
  schema: PRODUCT_CANARY_EVIDENCE_SCHEMA,
  canaryId: "product-2026-08-09T000000.000Z-aaaaaa",
  grantId: "grant-1",
  runId: "run-1",
  releaseId: "release-1",
  manifestSha256: "a".repeat(64),
  evaluatedAt: "2026-08-09T00:00:00.000Z",
  deepPromotion: node,
  matchingCanary: node,
  fieldMaterialization: node,
  workspaceCanary: node,
};

assert.doesNotThrow(() => validateProductCanaryEvidence(fixture));
assert.throws(
  () => validateProductCanaryEvidence({ ...fixture, manifestSha256: "short" }),
  /형식/,
);
assert.throws(
  () => validateProductCanaryEvidence({
    ...fixture,
    workspaceCanary: { status: "not_evaluated", summary: "잘못된 상태" },
  }),
  /형식/,
);

console.log("product canary evidence contract tests: ok");

const passed = evaluateProductCanaryObservation({
  promotionVerified: true,
  matchingVerified: true,
  matchingCompanyCount: 134,
  applicationEvidencePresent: true,
  connectedFieldCount: 37,
  seededAnswerCount: 3,
  precomputeStatus: "complete",
  workspaceMode: "admin_preview",
  workspaceLadder: "a",
  activeDocumentKey: "business_plan::사업계획서::지원사업 추진계획서.hwp::1",
  draftId: null,
  pollConversion: false,
  recoveryNeeded: false,
});
assert.deepEqual(
  Object.values(passed).map((item) => item.status),
  ["passed", "passed", "passed", "passed"],
);

const missingFields = evaluateProductCanaryObservation({
  promotionVerified: true,
  matchingVerified: true,
  matchingCompanyCount: 134,
  applicationEvidencePresent: true,
  connectedFieldCount: 0,
  seededAnswerCount: 0,
  precomputeStatus: "complete",
  workspaceMode: "admin_preview",
  workspaceLadder: "b",
  activeDocumentKey: "application_form::신청서::::0",
  draftId: null,
  pollConversion: false,
  recoveryNeeded: true,
});
assert.equal(missingFields.deepPromotion.status, "passed");
assert.equal(missingFields.matchingCanary.status, "passed");
assert.equal(missingFields.fieldMaterialization.status, "failed");
assert.equal(missingFields.workspaceCanary.status, "failed");

console.log("product canary observation tests: ok");
