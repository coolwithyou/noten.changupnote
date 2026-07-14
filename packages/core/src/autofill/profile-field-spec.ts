import type { CriterionDimension } from "@cunote/contracts";

export const OPERATIONAL_PROFILE_DIMENSIONS = [
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "business_status",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
] as const satisfies readonly CriterionDimension[];

export type ProfileFieldRole =
  | "eligibility"
  | "reserved_eligibility"
  | "grant_unstructured"
  | "supporting"
  | "identity_prerequisite"
  | "ranking"
  | "diagnostic";

export type ProfileFieldReadinessKind = "scalar" | "list" | "compound";

export interface ProfileFieldSpecEntry {
  key: string;
  parentDimension: CriterionDimension | null;
  role: ProfileFieldRole;
  profileOrUpdatePath: string;
  readinessKind: ProfileFieldReadinessKind;
  includedInEligibilityDenominator: boolean;
}

const eligibilityParent = <K extends (typeof OPERATIONAL_PROFILE_DIMENSIONS)[number]>(
  key: K,
  profileOrUpdatePath: string,
  readinessKind: ProfileFieldReadinessKind,
): ProfileFieldSpecEntry & { key: K; parentDimension: K } => ({
  key,
  parentDimension: key,
  role: "eligibility",
  profileOrUpdatePath,
  readinessKind,
  includedInEligibilityDenominator: true,
});

const field = <K extends string, P extends CriterionDimension | null>(
  key: K,
  parentDimension: P,
  role: ProfileFieldRole,
  profileOrUpdatePath: string,
  readinessKind: ProfileFieldReadinessKind,
): ProfileFieldSpecEntry & { key: K; parentDimension: P } => ({
  key,
  parentDimension,
  role,
  profileOrUpdatePath,
  readinessKind,
  includedInEligibilityDenominator: false,
});

/**
 * Matcher가 소비하는 CompanyProfile 경계와 typed update가 보존해야 할 최소 필드 목록.
 * provider, env key, 화면 라벨은 이 모듈에 두지 않는다.
 */
export const PROFILE_FIELD_SPEC = [
  eligibilityParent("region", "CompanyProfile.region.code", "scalar"),
  eligibilityParent("biz_age", "CompanyProfile.biz_age_months", "scalar"),
  eligibilityParent("industry", "CompanyProfile.industries", "list"),
  eligibilityParent("size", "CompanyProfile.size", "scalar"),
  eligibilityParent("revenue", "CompanyProfile.revenue_krw", "scalar"),
  eligibilityParent("employees", "CompanyProfile.employees_count", "scalar"),
  eligibilityParent("founder_age", "CompanyProfile.founder_age", "scalar"),
  eligibilityParent("founder_trait", "CompanyProfile.traits", "list"),
  eligibilityParent("certification", "CompanyProfile.certs", "list"),
  eligibilityParent("prior_award", "CompanyProfile.prior_award_history", "compound"),
  eligibilityParent("ip", "CompanyProfile.ip", "list"),
  eligibilityParent("target_type", "CompanyProfile.target_types", "list"),
  eligibilityParent("business_status", "CompanyProfile.business_status", "compound"),
  eligibilityParent("tax_compliance", "CompanyProfile.tax_compliance", "compound"),
  eligibilityParent("credit_status", "CompanyProfile.credit_status", "compound"),
  eligibilityParent("sanction", "CompanyProfile.sanction", "compound"),
  eligibilityParent("financial_health", "CompanyProfile.financial_health", "compound"),
  eligibilityParent("insured_workforce", "CompanyProfile.insured_workforce", "compound"),
  eligibilityParent("investment", "CompanyProfile.investment", "compound"),

  field("biz_age.is_preliminary", "biz_age", "eligibility", "CompanyProfile.is_preliminary", "scalar"),
  field("industry.industry_codes", "industry", "eligibility", "CompanyProfile.industry_codes", "list"),
  field("industry.list_completeness", "industry", "eligibility", "CompanyProfile.list_completeness.industry", "scalar"),
  field("founder_trait.list_completeness", "founder_trait", "eligibility", "CompanyProfile.list_completeness.founder_trait", "scalar"),
  field("certification.list_completeness", "certification", "eligibility", "CompanyProfile.list_completeness.certification", "scalar"),
  field("prior_award.records", "prior_award", "eligibility", "CompanyProfile.prior_award_history.records", "list"),
  field("prior_award.self_flags", "prior_award", "eligibility", "CompanyProfile.prior_award_history.self_flags", "compound"),
  field("prior_award.has_incubation_tenancy", "prior_award", "eligibility", "CompanyProfile.prior_award_history.has_incubation_tenancy", "scalar"),
  field("prior_award.known_programs", "prior_award", "eligibility", "CompanyProfile.prior_award_history.known_programs", "list"),
  field("prior_award.known_program_types", "prior_award", "eligibility", "CompanyProfile.prior_award_history.known_program_types", "list"),
  field("prior_award.list_completeness", "prior_award", "eligibility", "CompanyProfile.list_completeness.prior_award", "scalar"),
  field("ip.right_kinds", "ip", "eligibility", "CompanyProfile.ip", "list"),
  field("ip.right_statuses", "ip", "supporting", "CompanyProfileFieldUpdate.value", "list"),
  field("ip.list_completeness", "ip", "eligibility", "CompanyProfile.list_completeness.ip", "scalar"),
  field("target_type.legal_form", "target_type", "eligibility", "CompanyProfile.target_types", "list"),
  field("target_type.applicant_tags", "target_type", "eligibility", "CompanyProfile.target_types", "list"),
  field("target_type.list_completeness", "target_type", "eligibility", "CompanyProfile.list_completeness.target_type", "scalar"),
  field("business_status.active", "business_status", "eligibility", "CompanyProfile.business_status.active", "scalar"),
  field("tax_compliance.flags", "tax_compliance", "eligibility", "CompanyProfile.tax_compliance.flags", "list"),
  field("tax_compliance.known_flags", "tax_compliance", "eligibility", "CompanyProfile.tax_compliance.known_flags", "list"),
  field("tax_compliance.exceptions", "tax_compliance", "eligibility", "CompanyProfile.tax_compliance.exceptions", "list"),
  field("credit_status.flags", "credit_status", "eligibility", "CompanyProfile.credit_status.flags", "list"),
  field("credit_status.known_flags", "credit_status", "eligibility", "CompanyProfile.credit_status.known_flags", "list"),
  field("credit_status.exceptions", "credit_status", "eligibility", "CompanyProfile.credit_status.exceptions", "list"),
  field("sanction.flags", "sanction", "eligibility", "CompanyProfile.sanction.flags", "list"),
  field("sanction.known_flags", "sanction", "eligibility", "CompanyProfile.sanction.known_flags", "list"),
  field("sanction.exceptions", "sanction", "eligibility", "CompanyProfile.sanction.exceptions", "list"),
  field("financial_health.debt_ratio_pct", "financial_health", "eligibility", "CompanyProfile.financial_health.debt_ratio_pct", "scalar"),
  field("financial_health.impairment", "financial_health", "eligibility", "CompanyProfile.financial_health.impairment", "scalar"),
  field("financial_health.interest_coverage_ratio", "financial_health", "eligibility", "CompanyProfile.financial_health.interest_coverage_ratio", "scalar"),
  field("financial_health.total_assets_krw", "financial_health", "supporting", "CompanyProfile.financial_health.total_assets_krw", "scalar"),
  field("financial_health.equity_krw", "financial_health", "supporting", "CompanyProfile.financial_health.equity_krw", "scalar"),
  field("financial_health.capital_krw", "financial_health", "supporting", "CompanyProfile.financial_health.capital_krw", "scalar"),
  field("financial_health.fiscal_year", "financial_health", "supporting", "CompanyProfile.financial_health.fiscal_year", "scalar"),
  field("insured_workforce.employment_insurance_active", "insured_workforce", "eligibility", "CompanyProfile.insured_workforce.employment_insurance_active", "scalar"),
  field("insured_workforce.insured_count", "insured_workforce", "eligibility", "CompanyProfile.insured_workforce.insured_count", "scalar"),
  field("insured_workforce.months_since_last_layoff", "insured_workforce", "eligibility", "CompanyProfile.insured_workforce.months_since_last_layoff", "scalar"),
  field("insured_workforce.no_layoff", "insured_workforce", "eligibility", "CompanyProfile.insured_workforce.no_layoff", "scalar"),
  field("investment.total_raised_krw", "investment", "eligibility", "CompanyProfile.investment.total_raised_krw", "scalar"),
  field("investment.last_round", "investment", "eligibility", "CompanyProfile.investment.last_round", "scalar"),
  field("investment.tips_backed", "investment", "eligibility", "CompanyProfile.investment.tips_backed", "scalar"),

  field("premises", "premises", "reserved_eligibility", "CompanyProfileFieldUpdate.value", "compound"),
  field("export_performance", "export_performance", "reserved_eligibility", "CompanyProfileFieldUpdate.value", "compound"),
  field("other", "other", "grant_unstructured", "CompanyProfile.other_conditions", "compound"),

  field("identity.business_number", null, "identity_prerequisite", "CompanyProfile.id", "scalar"),
  field("identity.company_name", null, "identity_prerequisite", "CompanyProfile.name", "scalar"),
  field("identity.corporate_registration_number", null, "identity_prerequisite", "CompanyProfile.other_conditions.apick_corporate_registration_no", "scalar"),
  field("identity.authentication_status", null, "identity_prerequisite", "CompanyProfile.other_conditions.authentication_status", "scalar"),
  field("identity.registry_match_method", null, "identity_prerequisite", "CompanyProfile.other_conditions.registry_match_method", "scalar"),
  field("ranking.support_goals", null, "ranking", "CompanyProfile.other_conditions.support_goals", "list"),
  field("ranking.interest_goals", null, "ranking", "CompanyProfile.other_conditions.interest_goals", "list"),
  field("diagnostic.source_kind", null, "diagnostic", "CompanyProfileFieldUpdate.sourceKind", "scalar"),
  field("diagnostic.as_of", null, "diagnostic", "CompanyProfileFieldUpdate.asOf", "scalar"),
  field("diagnostic.confidence", null, "diagnostic", "CompanyProfileFieldUpdate.confidence", "scalar"),
  field("diagnostic.axis_completeness", null, "diagnostic", "CompanyProfileFieldUpdate.axisCompleteness", "scalar"),
] as const satisfies readonly ProfileFieldSpecEntry[];

export type ProfileFieldKey = (typeof PROFILE_FIELD_SPEC)[number]["key"];

export const PROFILE_FIELD_SPEC_BY_KEY: ReadonlyMap<ProfileFieldKey, ProfileFieldSpecEntry> =
  new Map(PROFILE_FIELD_SPEC.map((entry) => [entry.key, entry]));

export function requireProfileFieldKey(key: string): ProfileFieldKey {
  if (!PROFILE_FIELD_SPEC_BY_KEY.has(key as ProfileFieldKey)) {
    throw new Error(`Unknown profile field key: ${key}`);
  }
  return key as ProfileFieldKey;
}
