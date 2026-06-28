export const CRITERION_DIMENSIONS = [
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
  "other",
] as const;

export const CRITERION_OPERATORS = [
  "in",
  "not_in",
  "lte",
  "gte",
  "between",
  "exists",
  "text_only",
] as const;

export const CRITERION_KINDS = ["required", "preferred", "exclusion"] as const;
export const ELIGIBILITIES = ["eligible", "conditional", "ineligible"] as const;
export const GRANT_BENEFIT_FAMILIES = [
  "funding",
  "loan",
  "capability",
  "space",
  "market",
  "certification",
  "network",
] as const;
export const GRANT_BENEFIT_SOURCES = [
  "structured",
  "support_amount",
  "title",
  "category",
  "apply_method",
] as const;
export const GRANT_DOCUMENT_CATEGORIES = [
  "application_form",
  "business_plan",
  "proposal_or_intro",
  "consent_or_pledge",
  "business_registration",
  "corporate_register",
  "company_confirmation",
  "financial_tax",
  "employment_insurance",
  "shareholder",
  "bank_account",
  "estimate_budget",
  "portfolio_catalog",
  "ip_certification",
  "recommendation",
  "performance_evidence",
  "other",
] as const;
export const GRANT_DOCUMENT_PREPARATION_TYPES = [
  "write",
  "issue",
  "attach",
  "portal",
  "other",
] as const;

export type CriterionDimension = (typeof CRITERION_DIMENSIONS)[number];
export type CriterionOperator = (typeof CRITERION_OPERATORS)[number];
export type CriterionKind = (typeof CRITERION_KINDS)[number];
export type Eligibility = (typeof ELIGIBILITIES)[number];
export type CriterionResult = "pass" | "fail" | "unknown";
export type GrantSource = "kstartup" | "bizinfo" | "bizinfo_event";
export type GrantStatus = "upcoming" | "open" | "closed" | "unknown";
export type GrantDocumentSource = "self" | "portal" | "cert";
export type GrantBenefitFamily = (typeof GRANT_BENEFIT_FAMILIES)[number];
export type GrantBenefitSource = (typeof GRANT_BENEFIT_SOURCES)[number];
export type GrantDocumentCategory = (typeof GRANT_DOCUMENT_CATEGORIES)[number];
export type GrantDocumentPreparationType = (typeof GRANT_DOCUMENT_PREPARATION_TYPES)[number];

export interface GrantSupportAmount {
  min?: number | null;
  max?: number | null;
  unit: "KRW";
  per: "기업" | "건";
  label?: string | null;
}

export interface GrantRequiredDocument {
  name: string;
  required: boolean;
  source: GrantDocumentSource;
  category?: GrantDocumentCategory;
  preparation_type?: GrantDocumentPreparationType;
  canonical_name?: string;
  template_required?: boolean;
  source_attachment?: string;
  source_span?: string;
  note?: string;
  confidence?: number;
}

export interface GrantBenefit {
  family: GrantBenefitFamily;
  label: string;
  source: GrantBenefitSource;
  confidence?: number;
}

export interface GrantObligation {
  label: string;
  source: GrantBenefitSource;
  confidence?: number;
}

export interface RegionCriterionValue {
  regions: string[];
  labels?: string[];
  nationwide?: boolean;
  region_group?: string;
}

export interface BizAgeCriterionValue {
  max_months?: number | null;
  min_months?: number | null;
  include_preliminary?: boolean;
  basis?: string;
  labels?: string[];
}

export interface FounderAgeRange {
  min?: number | null;
  max?: number | null;
  label: string;
}

export interface FounderAgeCriterionValue {
  ranges: FounderAgeRange[];
  labels: string[];
  youth_only?: boolean;
}

export interface ListCriterionValue {
  tags?: string[];
  sizes?: string[];
  traits?: string[];
  certs?: string[];
  programs?: string[];
  targets?: string[];
  types?: string[];
}

export interface TextOnlyCriterionValue {
  note: string;
}

export type CriterionValue =
  | RegionCriterionValue
  | BizAgeCriterionValue
  | FounderAgeCriterionValue
  | ListCriterionValue
  | TextOnlyCriterionValue
  | Record<string, unknown>;

export interface GrantCriterion {
  id?: string;
  grant_id?: string;
  dimension: CriterionDimension;
  operator: CriterionOperator;
  value: CriterionValue;
  kind: CriterionKind;
  weight?: number;
  confidence: number;
  source_span?: string;
  raw_text?: string;
  source_field?: string;
  needs_review?: boolean;
  parser_version?: string;
}

export interface Grant {
  id?: string;
  source: GrantSource;
  source_id: string;
  title: string;
  url?: string | null;
  agency_jurisdiction?: string | null;
  agency_operator?: string | null;
  category_l1?: string | null;
  category_l2?: string | null;
  apply_start?: string | null;
  apply_end?: string | null;
  apply_method?: Record<string, string | null>;
  support_amount?: GrantSupportAmount | Record<string, unknown> | null;
  required_documents?: GrantRequiredDocument[] | null;
  benefits?: GrantBenefit[] | null;
  obligations?: GrantObligation[] | null;
  status: GrantStatus;
  f_regions: string[];
  f_industries: string[];
  f_biz_age_min_months?: number | null;
  f_biz_age_max_months?: number | null;
  f_sizes: string[];
  f_founder_traits: string[];
  f_required_certs: string[];
  overall_confidence: number;
  model_ver?: string | null;
  prompt_ver?: string | null;
  parser_version?: string;
  updated_at?: string | null;
}

export interface GrantRaw<TPayload = unknown> {
  source: GrantSource;
  source_id: string;
  payload: TPayload;
  attachments?: Array<{
    filename: string;
    url?: string | null;
    source_uri?: string | null;
    archive_url?: string | null;
    storage_key?: string | null;
    content_type?: string | null;
    bytes?: number | null;
    sha256?: string | null;
    fetched_at?: string | null;
    conversion?: {
      status: "converted" | "skipped" | "failed";
      markdown_url?: string | null;
      markdown_storage_key?: string | null;
      markdown_sha256?: string | null;
      markdown_bytes?: number | null;
      converter?: string | null;
      converted_at?: string | null;
      error?: string | null;
    };
  }> | null;
  raw_hash?: string;
  collected_at?: string;
  status: "fetched" | "converted" | "extracted" | "normalized" | "published" | "failed";
}

export interface NormalizedGrant<TPayload = unknown> {
  raw: GrantRaw<TPayload>;
  grant: Grant;
  criteria: GrantCriterion[];
}

export interface CompanyProfile {
  id?: string;
  name?: string;
  region?: {
    code: string;
    label?: string;
  };
  biz_age_months?: number | null;
  founder_age?: number | null;
  is_preliminary?: boolean;
  industries?: string[];
  size?: string | null;
  revenue_krw?: number | null;
  employees_count?: number | null;
  traits?: string[];
  certs?: string[];
  prior_awards?: string[];
  ip?: string[];
  target_types?: string[];
  other_conditions?: Record<string, unknown> | null;
  business_status?: {
    active?: boolean;
    close_down_state?: string | number | null;
    close_down_tax_type?: string | number | null;
    label?: string;
  };
  confidence?: Partial<Record<CriterionDimension, number>>;
}

export interface RuleTraceEntry {
  criterion_id?: string;
  dimension: CriterionDimension;
  kind: CriterionKind;
  operator: CriterionOperator;
  result: CriterionResult;
  source_span?: string;
  company_value?: unknown;
  message: string;
}

export interface NextQuestion {
  field: CriterionDimension;
  prompt: string;
  reason: string;
}

export interface MatchResult {
  eligibility: Eligibility;
  fit_score: number;
  rule_trace: RuleTraceEntry[];
  unknown_fields: CriterionDimension[];
  next_question?: NextQuestion;
  ruleset_ver: string;
  scoring_ver: string;
}

export * from "./dto.js";
export * from "./openapi.js";
