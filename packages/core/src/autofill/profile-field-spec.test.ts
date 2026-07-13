import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  OPERATIONAL_PROFILE_DIMENSIONS,
  PROFILE_FIELD_SPEC,
  PROFILE_FIELD_SPEC_BY_KEY,
  requireProfileFieldKey,
} from "./profile-field-spec.js";

assert.equal(OPERATIONAL_PROFILE_DIMENSIONS.length, 19);
assert.equal(new Set(OPERATIONAL_PROFILE_DIMENSIONS).size, 19);
assert.equal(PROFILE_FIELD_SPEC_BY_KEY.size, PROFILE_FIELD_SPEC.length, "field key는 중복되면 안 된다");

const parentRows = PROFILE_FIELD_SPEC.filter(
  (entry) => entry.parentDimension !== null && entry.key === entry.parentDimension,
);
assert.deepEqual(
  parentRows.map((entry) => entry.key),
  [...CRITERION_DIMENSIONS],
  "22개 criterion dimension은 부모 행으로 정확히 한 번씩 존재해야 한다",
);

const denominatorRows = PROFILE_FIELD_SPEC.filter((entry) => entry.includedInEligibilityDenominator);
assert.deepEqual(
  denominatorRows.map((entry) => entry.key),
  [...OPERATIONAL_PROFILE_DIMENSIONS],
  "eligibility 분모는 운영 19축 부모 행만 포함해야 한다",
);
assert.ok(denominatorRows.every((entry) => entry.role === "eligibility"));

const other = PROFILE_FIELD_SPEC_BY_KEY.get("other");
assert.equal(other?.role, "grant_unstructured");
assert.equal(other?.includedInEligibilityDenominator, false);
for (const key of ["premises", "export_performance"] as const) {
  const reserved = PROFILE_FIELD_SPEC_BY_KEY.get(key);
  assert.equal(reserved?.role, "reserved_eligibility");
  assert.equal(reserved?.includedInEligibilityDenominator, false);
}

const requiredMatcherPaths = {
  "biz_age.is_preliminary": "CompanyProfile.is_preliminary",
  "industry.industry_codes": "CompanyProfile.industry_codes",
  "industry.list_completeness": "CompanyProfile.list_completeness.industry",
  "founder_trait.list_completeness": "CompanyProfile.list_completeness.founder_trait",
  "certification.list_completeness": "CompanyProfile.list_completeness.certification",
  "prior_award.records": "CompanyProfile.prior_award_history.records",
  "prior_award.self_flags": "CompanyProfile.prior_award_history.self_flags",
  "prior_award.has_incubation_tenancy": "CompanyProfile.prior_award_history.has_incubation_tenancy",
  "prior_award.known_programs": "CompanyProfile.prior_award_history.known_programs",
  "prior_award.known_program_types": "CompanyProfile.prior_award_history.known_program_types",
  "prior_award.list_completeness": "CompanyProfile.list_completeness.prior_award",
  ip: "CompanyProfile.ip",
  "ip.right_kinds": "CompanyProfile.ip",
  "ip.right_statuses": "CompanyProfileFieldUpdate.value",
  "ip.list_completeness": "CompanyProfile.list_completeness.ip",
  "target_type.legal_form": "CompanyProfile.target_types",
  "target_type.applicant_tags": "CompanyProfile.target_types",
  "target_type.list_completeness": "CompanyProfile.list_completeness.target_type",
  "financial_health.debt_ratio_pct": "CompanyProfile.financial_health.debt_ratio_pct",
  "financial_health.impairment": "CompanyProfile.financial_health.impairment",
  "financial_health.interest_coverage_ratio": "CompanyProfile.financial_health.interest_coverage_ratio",
  "financial_health.capital_krw": "CompanyProfile.financial_health.capital_krw",
  "financial_health.fiscal_year": "CompanyProfile.financial_health.fiscal_year",
  "insured_workforce.employment_insurance_active": "CompanyProfile.insured_workforce.employment_insurance_active",
  "insured_workforce.insured_count": "CompanyProfile.insured_workforce.insured_count",
  "insured_workforce.months_since_last_layoff": "CompanyProfile.insured_workforce.months_since_last_layoff",
  "insured_workforce.no_layoff": "CompanyProfile.insured_workforce.no_layoff",
} as const;

for (const [key, expectedPath] of Object.entries(requiredMatcherPaths)) {
  const entry = PROFILE_FIELD_SPEC_BY_KEY.get(requireProfileFieldKey(key));
  assert.equal(entry?.profileOrUpdatePath, expectedPath, `${key} matcher path parity`);
  assert.equal(entry?.includedInEligibilityDenominator, key === entry?.parentDimension);
}
assert.equal(PROFILE_FIELD_SPEC_BY_KEY.get("ip.right_statuses")?.role, "supporting");

for (const key of [
  "identity.business_number",
  "identity.company_name",
  "identity.corporate_registration_number",
  "identity.authentication_status",
  "identity.registry_match_method",
] as const) {
  assert.equal(PROFILE_FIELD_SPEC_BY_KEY.get(key)?.role, "identity_prerequisite");
}
for (const key of ["ranking.support_goals", "ranking.interest_goals"] as const) {
  assert.equal(PROFILE_FIELD_SPEC_BY_KEY.get(key)?.role, "ranking");
}

const minimalKeys = [
  "includedInEligibilityDenominator",
  "key",
  "parentDimension",
  "profileOrUpdatePath",
  "readinessKind",
  "role",
];
for (const entry of PROFILE_FIELD_SPEC) {
  assert.deepEqual(Object.keys(entry).sort(), minimalKeys, `${entry.key}는 최소 field spec만 가져야 한다`);
}

console.log("autofill/profile-field-spec.test.ts: all assertions passed");
