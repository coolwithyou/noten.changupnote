import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, PriorAwardCriterionValue } from "@cunote/contracts";
import { matchGrantCriteria } from "../matching/match.js";

const asOf = new Date("2026-07-12T00:00:00.000Z");

check("self current_similar true exclusion -> fail", selfValue("current_similar"), profile({
  self_flags: { current_similar: true },
}), "fail");
check("self current_similar false exclusion -> pass", selfValue("current_similar"), profile({
  self_flags: { current_similar: false },
}), "pass");
check("self unqueried -> unknown", selfValue("current_similar"), profile({
  self_flags: { same_year_other_support: false },
}), "unknown");
check("different self kinds are independent", selfValue("same_business_prior"), profile({
  self_flags: { current_similar: false },
}), "unknown");
check("incubation tenancy true -> fail", {
  scope: "self", channel: "incubation_tenancy",
}, profile({ has_incubation_tenancy: true }), "fail");
check("incubation tenancy unqueried -> unknown", {
  scope: "self", channel: "incubation_tenancy",
}, profile({}), "unknown");

check("program_type participating exclusion -> fail", {
  scope: "program_type", programs: ["startup_academy"], states: ["participating"],
}, profile({
  records: [{ program: "청년창업사관학교", state: "participating", year: 2026 }],
  known_program_types: ["startup_academy"],
}), "fail");
check("program_type unqueried -> unknown", {
  scope: "program_type", programs: ["startup_academy"], states: ["graduated"],
}, profile({ known_program_types: [] }), "unknown");

check("program records empty and unqueried -> unknown", programValue(), profile({
  records: [], known_programs: [],
}), "unknown");
check("program records empty but queried -> pass", programValue(), profile({
  records: [], known_programs: ["chogi_startup_package"],
}), "pass");
check("program outside 3 years -> pass", { ...programValue(), within: { value: 3, unit: "year" } }, profile({
  records: [{ program: "2020년 초기창업패키지", state: "completed", year: 2020 }],
  known_programs: ["chogi_startup_package"],
}), "pass");
check("program unknown year within window -> unknown", { ...programValue(), within: { value: 3, unit: "year" } }, profile({
  records: [{ program: "초기창업패키지", state: "completed", year: null }],
  known_programs: ["chogi_startup_package"],
}), "unknown");
check("required history absent -> fail", programValue(), profile({
  records: [], known_programs: ["chogi_startup_package"],
}), "fail", "required");
check("preferred graduated history -> pass", {
  scope: "program_type", programs: ["startup_nest"], states: ["graduated"],
}, profile({
  records: [{ program: "Start-up NEST", state: "graduated", year: 2025 }],
  known_program_types: ["startup_nest"],
}), "pass", "preferred");

const legacyHit = result({ programs: ["초기창업패키지"] }, {
  prior_awards: ["2024년 초기창업패키지(예비)"],
  list_completeness: { prior_award: "complete" },
  confidence: { prior_award: 0.6 },
});
assert.equal(legacyHit, "fail", "legacy free strings use canonical matching instead of exact string equality");
const legacyPartialNoHit = result({ programs: ["초기창업패키지"] }, {
  prior_awards: ["TIPS"],
  list_completeness: { prior_award: "partial" },
  confidence: { prior_award: 0.6 },
});
assert.equal(legacyPartialNoHit, "unknown", "partial legacy list cannot prove absence");
const legacySingularProgram = result({ program: "통상닥터", note: "통상닥터 참여기업이어야 함" }, {
  prior_awards: ["통상닥터"],
  list_completeness: { prior_award: "complete" },
  confidence: { prior_award: 0.6 },
}, "required");
assert.equal(legacySingularProgram, "pass", "legacy singular program must adapt to program scope");

console.log("prior-award/evaluate.test.ts: all assertions passed");

function check(
  label: string,
  value: PriorAwardCriterionValue,
  company: CompanyProfile,
  expected: "pass" | "fail" | "unknown",
  kind: GrantCriterion["kind"] = "exclusion",
): void {
  assert.equal(result(value, company, kind), expected, label);
}
function result(value: unknown, company: CompanyProfile, kind: GrantCriterion["kind"] = "exclusion") {
  const criterion: GrantCriterion = {
    dimension: "prior_award",
    operator: "in",
    kind,
    value: value as Record<string, unknown>,
    confidence: 0.95,
    source_span: "수혜 이력 조건",
  };
  return matchGrantCriteria([criterion], company, { asOf }).rule_trace[0]?.result;
}
function profile(overrides: Partial<NonNullable<CompanyProfile["prior_award_history"]>>): CompanyProfile {
  return {
    prior_award_history: {
      records: [],
      known_programs: [],
      known_program_types: [],
      ...overrides,
    },
    confidence: { prior_award: 0.6 },
  };
}
function selfValue(self_kind: "current_similar" | "same_project" | "same_business_prior" | "same_year_other_support"): PriorAwardCriterionValue {
  return { scope: "self", self_kind };
}
function programValue(): PriorAwardCriterionValue {
  return { scope: "program", programs: ["chogi_startup_package"] };
}
