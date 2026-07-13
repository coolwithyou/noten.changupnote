import assert from "node:assert/strict";
import {
  CANONICAL_PRIOR_AWARD_PROGRAMS,
  PRIOR_AWARD_PROGRAM_QUESTION_COVERAGE,
  normalizePriorAwardProgramLabel,
} from "./canonical.js";

assert.equal(normalizePriorAwardProgramLabel("2026년도 초기창업패키지(딥테크 특화형)"), "chogi_startup_package");
assert.equal(normalizePriorAwardProgramLabel("청년창업사관학교 15기"), "startup_academy");
assert.equal(normalizePriorAwardProgramLabel("Start-up NEST Space"), "startup_nest");
assert.equal(normalizePriorAwardProgramLabel("알 수 없는 지역사업"), null);

const covered = new Set(Object.values(PRIOR_AWARD_PROGRAM_QUESTION_COVERAGE).flat());
assert.deepEqual(
  CANONICAL_PRIOR_AWARD_PROGRAMS.filter((item) => !covered.has(item.key)).map((item) => item.key),
  [],
  "every canonical program/program_type must be covered by a question group",
);

console.log("prior-award/canonical.test.ts: all assertions passed");
