import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  activeUnknownQuestionDimensions,
  clearProfileQuestionAnswerState,
  activeNumericQuestionRange,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
} from "./question-answer-state.js";

const base: CompanyProfile = { confidence: {} };
const marked = markProfileQuestionUnknown({
  profile: base,
  dimension: "founder_age",
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
  ttlDays: 30,
  rulesetVer: "ruleset-test",
});
assert.equal(marked.founder_age, undefined, "unknown 응답은 프로필 값으로 쓰면 안 된다");
assert.deepEqual(marked.question_answer_state?.founder_age, {
  status: "unknown",
  answeredAt: "2026-07-12T00:00:00.000Z",
  expiresAt: "2026-08-11T00:00:00.000Z",
  sourceKind: "self_declared",
  rulesetVer: "ruleset-test",
});
assert.deepEqual(activeUnknownQuestionDimensions(marked, new Date("2026-08-10T23:59:59.000Z")), ["founder_age"]);
assert.deepEqual(activeUnknownQuestionDimensions(marked, new Date("2026-08-11T00:00:00.000Z")), []);
assert.equal(clearProfileQuestionAnswerState(marked, "founder_age").question_answer_state, undefined);
assert.equal(base.question_answer_state, undefined, "원본 프로필은 불변이어야 한다");

const ranged = markProfileQuestionRange({
  profile: base,
  dimension: "employees",
  range: { min: 5, max: 9, unit: "people" },
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
  ttlDays: 180,
  rulesetVer: "ruleset-test",
});
assert.deepEqual(activeNumericQuestionRange(ranged, "employees", new Date("2026-07-13T00:00:00.000Z")), {
  min: 5,
  max: 9,
  unit: "people",
});
assert.equal(ranged.question_answer_state?.employees?.status, "range");
assert.equal(ranged.profile_evidence?.employees?.axisCompleteness, "partial");
assert.deepEqual(activeUnknownQuestionDimensions(ranged), [], "range 응답은 모름 TTL 억제와 구분해야 한다");

console.log("question-answer-state: ok");
