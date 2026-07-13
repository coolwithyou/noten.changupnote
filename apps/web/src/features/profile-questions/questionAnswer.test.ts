import assert from "node:assert/strict";
import type { NextQuestionDto } from "@cunote/contracts";
import {
  buildDisqualificationAnswers,
  buildNumberGroupValue,
  buildPriorAwardQuestionValue,
  defaultQuestionValue,
  parseQuestionValue,
  selectedQuestionRange,
  shouldMergeQuestionValue,
} from "./questionAnswer";

const region = question("region", "select", ["서울"]);
assert.equal(defaultQuestionValue(region), "");
assert.deepEqual(parseQuestionValue(region, "서울"), { code: "11", label: "서울" });

const priorAward = question("prior_award", "select", ["해당 없음", "초기창업패키지"]);
assert.deepEqual(parseQuestionValue(priorAward, "해당 없음"), []);
assert.equal(shouldMergeQuestionValue(priorAward, "해당 없음"), false);
assert.deepEqual(parseQuestionValue(priorAward, "초기창업패키지"), ["초기창업패키지"]);
assert.equal(shouldMergeQuestionValue(priorAward, "초기창업패키지"), true);

const answers = buildDisqualificationAnswers(
  "tax_compliance",
  ["national_tax_delinquent", "local_tax_delinquent"],
  ["national_tax_delinquent"],
);
assert.deepEqual(answers.tax_delinquency_group?.held, ["national_tax_delinquent"]);

assert.deepEqual(buildNumberGroupValue("financial_health", {
  capital_impaired: "false",
  debt_ratio_pct: "120.9",
  interest_coverage_ratio: "-0.5",
}), {
  capital_impaired: false,
  debt_ratio_pct: 120,
  interest_coverage_ratio: -0.5,
});
assert.equal(buildNumberGroupValue("investment", {}), null);

assert.deepEqual(buildPriorAwardQuestionValue({
  scope: "self", selfKind: "same_year_other_support", channel: "general", requiresYear: false,
}, { hasHistory: false }), {
  self_flags: { same_year_other_support: false },
});
assert.deepEqual(buildPriorAwardQuestionValue({
  scope: "program", programs: ["chogi_startup_package"], states: ["completed"], requiresYear: true,
}, { hasHistory: true, state: "completed", year: 2024 }), {
  records: [{ program: "chogi_startup_package", state: "completed", year: 2024 }],
  known_programs: ["chogi_startup_package"],
});
assert.deepEqual(buildPriorAwardQuestionValue({
  scope: "program_type", programs: ["startup_academy"], requiresYear: false,
}, { hasHistory: false }), {
  records: [],
  known_program_types: ["startup_academy"],
});

const revenueRangeQuestion: NextQuestionDto = {
  ...question("revenue", "select"),
  responseStage: "range",
  rangeOptions: [{ value: "revenue-1-to-3eok", label: "1억원 이상 3억원 미만", min: 100_000_000, max: 299_999_999, unit: "krw" }],
};
assert.deepEqual(selectedQuestionRange(revenueRangeQuestion, "revenue-1-to-3eok"), {
  value: "revenue-1-to-3eok",
  label: "1억원 이상 3억원 미만",
  min: 100_000_000,
  max: 299_999_999,
  unit: "krw",
});

console.log("profile-question-answer: ok");

function question(
  dimension: NextQuestionDto["dimension"],
  inputType: NextQuestionDto["inputType"],
  options?: string[],
): NextQuestionDto {
  return {
    dimension,
    definitionId: `profile.${dimension}.v1`,
    inputType,
    preciseFollowUp: "never",
    ...(options ? { options } : {}),
    prompt: "test",
    framing: "test",
    affectedGrantCount: 1,
  };
}
