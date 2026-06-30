import assert from "node:assert/strict";
import { buildSubmitFeedbackInput } from "./matchFeedback";

const selected = buildSubmitFeedbackInput({
  companyId: "company-1",
  grantId: "kstartup:grant-1",
  userId: "user-1",
  body: {
    kind: "selected",
    reasonCode: "selected",
    outcome: "selected",
    occurredAt: "2026-06-28T12:00:00+09:00",
    message: "선정 결과 확인",
    correction: {
      dimension: "industry",
      criterionId: "criterion-1",
      expectedEligibility: "conditional",
      correctedEligibility: "eligible",
      correctedResult: "pass",
      note: "담당자 확인 결과 업종 조건 충족",
    },
    payload: {
      source: "application_pipeline",
    },
  },
});

assert.equal(selected.kind, "selected");
assert.equal(selected.reasonCode, "selected");
assert.equal(selected.outcome, "selected");
assert.equal(selected.occurredAt, "2026-06-28T03:00:00.000Z");
assert.equal(selected.correction?.dimension, "industry");
assert.equal(selected.correction?.criterionId, "criterion-1");
assert.equal(selected.correction?.expectedEligibility, "conditional");
assert.equal(selected.correction?.correctedEligibility, "eligible");
assert.equal(selected.correction?.correctedResult, "pass");
assert.deepEqual(selected.payload, { source: "application_pipeline" });

const blocked = buildSubmitFeedbackInput({
  companyId: "company-1",
  grantId: "kstartup:grant-2",
  body: {
    kind: "blocked",
    reasonCode: "portal_blocked",
    correction: {
      dimension: "region",
      correctedEligibility: "ineligible",
      correctedResult: "fail",
    },
  },
});

assert.equal(blocked.kind, "blocked");
assert.equal(blocked.reasonCode, "portal_blocked");
assert.equal(blocked.correction?.dimension, "region");
assert.equal(blocked.correction?.correctedEligibility, "ineligible");

const sanitized = buildSubmitFeedbackInput({
  companyId: "company-1",
  grantId: "kstartup:grant-3",
  body: {
    kind: "not-a-kind" as never,
    reasonCode: "not-a-reason" as never,
    outcome: "done" as never,
    occurredAt: "not-a-date",
    correction: {
      dimension: "not-a-dimension" as never,
      expectedEligibility: "maybe" as never,
      correctedResult: "maybe" as never,
    },
    payload: ["not", "a", "record"] as never,
  },
});

assert.equal(sanitized.kind, "note");
assert.equal(sanitized.reasonCode, null);
assert.equal(sanitized.outcome, null);
assert.equal(sanitized.occurredAt, null);
assert.equal(sanitized.correction, null);
assert.equal(sanitized.payload, null);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "match_feedback_outcome_kind",
    "match_feedback_reason_code",
    "match_feedback_correction",
    "match_feedback_payload",
    "match_feedback_sanitization",
  ],
}, null, 2));
