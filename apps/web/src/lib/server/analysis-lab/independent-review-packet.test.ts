import assert from "node:assert/strict";
import { deriveIndependentReviewConsensus, normalizeReviewSequences } from "./independent-review-packet";

const findings = deriveIndependentReviewConsensus(7, {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "needs_edit", note: "OR 경로 범위 손실" },
    { criterionIndex: 2, verdict: "wrong", note: "협업 주제를 업종으로 오인" },
    { criterionIndex: 3, verdict: "unsure", note: "원문 범위 불명확" },
    { criterionIndex: 4, verdict: "needs_edit", note: "단독 판정" },
  ],
  axisReviews: [
    { dimension: "credit_status", verdict: "missed_condition", matchImpact: "eligibility", note: "채무불이행 누락" },
    { dimension: "region", verdict: "confirmed_absent", matchImpact: "not_applicable", note: null },
  ],
}, {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "needs_edit", note: "대안 한정 누락" },
    { criterionIndex: 2, verdict: "wrong", note: "신청기업 업종이 아님" },
    { criterionIndex: 3, verdict: "unsure", note: "추가 확인 필요" },
    { criterionIndex: 4, verdict: "correct", note: null },
  ],
  axisReviews: [
    { dimension: "credit_status", verdict: "missed_condition", matchImpact: "eligibility", note: "부도·채무불이행 누락" },
    { dimension: "region", verdict: "confirmed_absent", matchImpact: "not_applicable", note: null },
  ],
});

assert.deepEqual(
  findings.map((finding) => [finding.kind, finding.key, finding.verdict, finding.classification]),
  [
    ["axis", "credit_status", "missed_condition", "defect"],
    ["criterion", 1, "needs_edit", "defect"],
    ["criterion", 2, "wrong", "defect"],
    ["criterion", 3, "unsure", "unresolved"],
  ],
  "양쪽이 같은 정상 판정을 한 항목과 단독 결함은 합의 결함에서 제외한다",
);

assert.deepEqual(normalizeReviewSequences(undefined, [2, 0, 1]), [0, 1, 2]);
assert.deepEqual(normalizeReviewSequences([7, 0, 2], [0, 1, 2, 7]), [0, 2, 7]);
assert.throws(
  () => normalizeReviewSequences([0, 0], [0, 1]),
  /중복 없는 0 이상의 정수/,
);
assert.throws(
  () => normalizeReviewSequences([3], [0, 1]),
  /receipt에 없는 sequence/,
);

console.log("independent-review-packet tests passed");
