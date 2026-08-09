import assert from "node:assert/strict";
import { hasHumanReviewForRun } from "./run-review-policy";

const files = [
  "run-old.review.json",
  "run-new.json",
  "run-new.ai-review.claude-fable-5.json",
];

assert.equal(hasHumanReviewForRun(files, "run-old"), true);
assert.equal(
  hasHumanReviewForRun(files, "run-new"),
  false,
  "같은 공고의 과거 사람 검수가 현행 재분석 run을 차단하지 않음",
);

console.log("run review policy tests: ok");
