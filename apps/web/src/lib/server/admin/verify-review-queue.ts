import assert from "node:assert/strict";
import { buildAdminReviewQueueItems } from "./reviewQueue";

const rows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    targetType: "match",
    targetId: "company-1:kstartup:grant-1",
    type: "explicit_irrelevant",
    actor: "user",
    ts: new Date("2026-06-28T12:00:00+09:00"),
    value: {
      kind: "wrong",
      reasonCode: "wrong_high",
      message: "업종 판정이 다릅니다.",
      correction: {
        dimension: "industry",
        criterionId: "criterion-1",
        expectedEligibility: "eligible",
        correctedEligibility: "ineligible",
        correctedResult: "fail",
        note: "담당자 확인 결과 업종 미충족",
      },
    },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    targetType: "match",
    targetId: "company-1:kstartup:grant-2",
    type: "outcome",
    actor: "user",
    ts: new Date("2026-06-28T13:00:00+09:00"),
    value: {
      kind: "blocked",
      reasonCode: "portal_blocked",
      outcome: "blocked",
    },
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    targetType: "match",
    targetId: "company-1:kstartup:grant-3",
    type: "explicit_relevant",
    actor: "user",
    ts: new Date("2026-06-28T14:00:00+09:00"),
    value: {
      kind: "saved",
    },
  },
];

const queue = buildAdminReviewQueueItems(rows, 10);
assert.equal(queue.length, 2, "only wrong/blocked feedback enters review queue");

const wrong = queue[0]!;
assert.equal(wrong.feedbackId, rows[0]!.id);
assert.equal(wrong.companyId, "company-1");
assert.equal(wrong.grantId, "kstartup:grant-1");
assert.equal(wrong.priority, "high");
assert.equal(wrong.correction?.dimension, "industry");
assert.equal(wrong.goldenCandidate?.ready, true);
assert.equal(wrong.goldenCandidate?.ref, `feedback:${rows[0]!.id}`);
assert.equal(wrong.goldenCandidate?.gold.expected, "ineligible");

const blocked = queue[1]!;
assert.equal(blocked.kind, "blocked");
assert.equal(blocked.priority, "high");
assert.equal(blocked.goldenCandidate?.ready, false);
assert.deepEqual(blocked.goldenCandidate?.missing, ["correctedEligibility"]);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "review_queue_filters_feedback",
    "review_queue_target_split",
    "review_queue_priority",
    "review_queue_golden_candidate_ready",
    "review_queue_incomplete_candidate_guard",
  ],
}, null, 2));
