import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import type { CompanyEvidence, CompanyProfile, CriterionDimension, TeaserRequest } from "@cunote/contracts";
import {
  buildCompanyEvidence,
  loadCompanyProfileResolutionForTeaser,
  mergeCompanyProfilesForEnrichment,
} from "@/lib/server/serviceData";

export async function resolveTeaserCompanyProfile(body: Partial<TeaserRequest>): Promise<CompanyProfile> {
  return (await resolveTeaserCompanyProfileWithEvidence(body)).profile;
}

export async function resolveTeaserCompanyProfileWithEvidence(body: Partial<TeaserRequest>): Promise<{
  profile: CompanyProfile;
  evidence: CompanyEvidence | null;
}> {
  if (isRecord(body.profile)) {
    const manualProfile = normalizeManualProfile(body.profile);
    const bizNo = body.bizNo?.trim() || undefined;
    if (bizNo) {
      const base = await loadCompanyProfileResolutionForTeaser(bizNo);
      const profile = mergeCompanyProfilesForEnrichment(base.profile, manualProfile);
      return {
        profile,
        evidence: buildMergedManualEvidence(base.evidence, profile),
      };
    }

    return {
      profile: manualProfile,
      evidence: buildCompanyEvidence({
        provider: "manual",
        source: "manual_profile",
        cacheStatus: "none",
        profile: manualProfile,
        summary: "직접 입력한 회사 프로필로 매칭했습니다.",
      }),
    };
  }
  return loadCompanyProfileResolutionForTeaser(body.bizNo?.trim() || undefined);
}

export function normalizeManualProfile(input: Record<string, unknown>): CompanyProfile {
  const profile: CompanyProfile = {};
  const region = normalizeRegion(input.region);
  const industries = normalizeStringArray(input.industries);
  const traits = normalizeStringArray(input.traits);
  const certs = normalizeStringArray(input.certs);
  const priorAwards = normalizeStringArray(input.prior_awards);
  const ip = normalizeStringArray(input.ip);
  const targetTypes = normalizeStringArray(input.target_types);
  const industryCodes = normalizeStringArray(input.industry_codes);
  const confidence = normalizeConfidence(input.confidence);

  const name = normalizeString(input.name);
  const size = normalizeString(input.size);
  const bizAgeMonths = normalizeNonNegativeNumber(input.biz_age_months);
  const founderAge = normalizeNonNegativeNumber(input.founder_age);
  const revenue = normalizeNonNegativeNumber(input.revenue_krw);
  const employees = normalizeNonNegativeNumber(input.employees_count);
  const businessStatus = normalizeBusinessStatus(input.business_status);
  const taxCompliance = normalizeDisqualification(input.tax_compliance);
  const creditStatus = normalizeDisqualification(input.credit_status);
  const sanction = normalizeDisqualification(input.sanction);
  const financialHealth = normalizeFinancialHealth(input.financial_health);
  const insuredWorkforce = normalizeInsuredWorkforce(input.insured_workforce);
  const investment = normalizeInvestment(input.investment);
  const questionAnswerState = normalizeQuestionAnswerState(input.question_answer_state);

  if (name) profile.name = name;
  if (region) profile.region = region;
  if (typeof input.is_preliminary === "boolean") profile.is_preliminary = input.is_preliminary;
  if (bizAgeMonths !== null) profile.biz_age_months = bizAgeMonths;
  if (founderAge !== null) profile.founder_age = founderAge;
  if (revenue !== null) profile.revenue_krw = revenue;
  if (employees !== null) profile.employees_count = employees;
  if (industries.length > 0) profile.industries = industries;
  if (industries.length > 0) profile.list_completeness = { ...(profile.list_completeness ?? {}), industry: "partial" };
  if (industryCodes.length > 0) profile.industry_codes = industryCodes;
  if (size) profile.size = size;
  if (traits.length > 0) profile.traits = traits;
  if (traits.length > 0) profile.list_completeness = { ...(profile.list_completeness ?? {}), founder_trait: "partial" };
  if (certs.length > 0) profile.certs = certs;
  if (certs.length > 0) profile.list_completeness = { ...(profile.list_completeness ?? {}), certification: "partial" };
  if (priorAwards.length > 0) profile.prior_awards = priorAwards;
  if (priorAwards.length > 0) profile.list_completeness = { ...(profile.list_completeness ?? {}), prior_award: "partial" };
  if (ip.length > 0) profile.ip = ip;
  if (ip.length > 0) profile.list_completeness = { ...(profile.list_completeness ?? {}), ip: "partial" };
  if (targetTypes.length > 0) profile.target_types = targetTypes;
  if (targetTypes.length > 0) {
    profile.list_completeness = {
      ...(profile.list_completeness ?? {}),
      target_type: "partial",
    };
  }
  if (businessStatus) profile.business_status = businessStatus;
  if (taxCompliance) profile.tax_compliance = taxCompliance;
  if (creditStatus) profile.credit_status = creditStatus;
  if (sanction) profile.sanction = sanction;
  if (financialHealth) profile.financial_health = financialHealth;
  if (insuredWorkforce) profile.insured_workforce = insuredWorkforce;
  if (investment) profile.investment = investment;
  if (questionAnswerState) profile.question_answer_state = questionAnswerState;
  if (Object.keys(confidence).length > 0) profile.confidence = confidence;
  return withSelfDeclaredEvidence(profile);
}

function buildMergedManualEvidence(baseEvidence: CompanyEvidence | null, profile: CompanyProfile): CompanyEvidence {
  return buildCompanyEvidence({
    provider: baseEvidence?.provider ?? "manual",
    source: baseEvidence?.source ?? "manual_profile",
    cacheStatus: baseEvidence?.cacheStatus ?? "none",
    checkedAt: parseEvidenceDate(baseEvidence?.checkedAt),
    cachedUntil: parseEvidenceDate(baseEvidence?.cachedUntil),
    maskedBizNo: baseEvidence?.maskedBizNo ?? null,
    resultMessage: baseEvidence?.resultMessage ?? null,
    profile,
    summary: `${baseEvidence?.summary ?? "사업자 정보를 확인했습니다."} 직접 입력한 항목을 반영했습니다.`.trim(),
  });
}

function normalizeRegion(value: unknown): CompanyProfile["region"] | undefined {
  if (!isRecord(value)) return undefined;
  const code = normalizeString(value.code);
  if (!code) return undefined;
  const label = normalizeString(value.label);
  return label ? { code, label } : { code };
}

function normalizeBusinessStatus(value: unknown): CompanyProfile["business_status"] | undefined {
  if (!isRecord(value)) return undefined;
  const label = normalizeString(value.label);
  const active = typeof value.active === "boolean" ? value.active : undefined;
  if (label || active !== undefined) {
    return {
      ...(active !== undefined ? { active } : {}),
      ...(label ? { label } : {}),
    };
  }
  return undefined;
}

function normalizeDisqualification(value: unknown): CompanyProfile["tax_compliance"] | undefined {
  if (!isRecord(value)) return undefined;
  const flags = normalizeStringArray(value.flags);
  const knownFlags = normalizeStringArray(value.known_flags);
  const exceptions = normalizeStringArray(value.exceptions);
  if (flags.length === 0 && knownFlags.length === 0 && exceptions.length === 0) return undefined;
  return { flags, known_flags: knownFlags, exceptions };
}

function normalizeFinancialHealth(value: unknown): CompanyProfile["financial_health"] | undefined {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<CompanyProfile["financial_health"]> = {};
  const debtRatio = normalizeFiniteNumber(value.debt_ratio_pct, 0);
  const interestCoverage = normalizeFiniteNumber(value.interest_coverage_ratio);
  const totalAssets = normalizeFiniteNumber(value.total_assets_krw, 0);
  const equity = normalizeFiniteNumber(value.equity_krw);
  const capital = normalizeFiniteNumber(value.capital_krw, 0);
  if (debtRatio !== null) result.debt_ratio_pct = debtRatio;
  if (interestCoverage !== null) result.interest_coverage_ratio = interestCoverage;
  if (totalAssets !== null) result.total_assets_krw = totalAssets;
  if (equity !== null) result.equity_krw = equity;
  if (capital !== null) result.capital_krw = capital;
  if (value.impairment === "none" || value.impairment === "partial" || value.impairment === "full") {
    result.impairment = value.impairment;
  }
  const fiscalYear = normalizeString(value.fiscal_year);
  if (fiscalYear) result.fiscal_year = fiscalYear.slice(0, 20);
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeInsuredWorkforce(value: unknown): CompanyProfile["insured_workforce"] | undefined {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<CompanyProfile["insured_workforce"]> = {};
  if (typeof value.employment_insurance_active === "boolean") {
    result.employment_insurance_active = value.employment_insurance_active;
  }
  if (typeof value.no_layoff === "boolean") result.no_layoff = value.no_layoff;
  const insuredCount = normalizeNonNegativeNumber(value.insured_count);
  const monthsSinceLayoff = normalizeNonNegativeNumber(value.months_since_last_layoff);
  if (insuredCount !== null) result.insured_count = insuredCount;
  if (monthsSinceLayoff !== null) result.months_since_last_layoff = monthsSinceLayoff;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeInvestment(value: unknown): CompanyProfile["investment"] | undefined {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<CompanyProfile["investment"]> = {};
  const totalRaised = normalizeNonNegativeNumber(value.total_raised_krw);
  if (totalRaised !== null) result.total_raised_krw = totalRaised;
  const lastRound = normalizeString(value.last_round);
  if (lastRound) result.last_round = lastRound.slice(0, 100);
  if (typeof value.tips_backed === "boolean") result.tips_backed = value.tips_backed;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeQuestionAnswerState(value: unknown): CompanyProfile["question_answer_state"] | undefined {
  if (!isRecord(value)) return undefined;
  const now = Date.now();
  const result: NonNullable<CompanyProfile["question_answer_state"]> = {};
  for (const dimension of CRITERION_DIMENSIONS) {
    const raw = value[dimension];
    if (!isRecord(raw) || (raw.status !== "unknown" && raw.status !== "range")) continue;
    const answeredAt = Date.parse(typeof raw.answeredAt === "string" ? raw.answeredAt : "");
    const requestedExpiry = Date.parse(typeof raw.expiresAt === "string" ? raw.expiresAt : "");
    if (!Number.isFinite(answeredAt) || !Number.isFinite(requestedExpiry) || requestedExpiry <= now) continue;
    const ttlDays = raw.status === "unknown" ? 30 : 180;
    const expiresAt = Math.min(requestedExpiry, answeredAt + ttlDays * 86_400_000, now + ttlDays * 86_400_000);
    const common = {
      answeredAt: new Date(Math.min(answeredAt, now)).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      sourceKind: "self_declared" as const,
      rulesetVer: typeof raw.rulesetVer === "string" ? raw.rulesetVer.slice(0, 100) : null,
    };
    if (raw.status === "unknown") {
      result[dimension] = { status: "unknown", ...common };
      continue;
    }
    if (dimension !== "revenue" && dimension !== "employees") continue;
    const unit = dimension === "revenue" ? "krw" : "people";
    if (raw.unit !== unit || typeof raw.min !== "number" || !Number.isFinite(raw.min) || raw.min < 0) continue;
    const max = raw.max === null ? null : raw.max;
    if (max !== null && (typeof max !== "number" || !Number.isFinite(max) || max < raw.min)) continue;
    result[dimension] = { status: "range", ...common, min: Math.floor(raw.min), max: max === null ? null : Math.floor(max), unit };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function withSelfDeclaredEvidence(profile: CompanyProfile): CompanyProfile {
  const dimensions: Array<[CriterionDimension, boolean, "partial" | "complete"]> = [
    ["region", Boolean(profile.region), "complete"],
    ["biz_age", typeof profile.biz_age_months === "number", "complete"],
    ["founder_age", typeof profile.founder_age === "number", "complete"],
    ["industry", Boolean(profile.industries?.length || profile.industry_codes?.length), "partial"],
    ["size", Boolean(profile.size), "complete"],
    ["revenue", typeof profile.revenue_krw === "number", "complete"],
    ["employees", typeof profile.employees_count === "number", "complete"],
    ["founder_trait", Boolean(profile.traits?.length), "partial"],
    ["certification", Boolean(profile.certs?.length), "partial"],
    ["prior_award", Boolean(profile.prior_awards?.length), "partial"],
    ["ip", Boolean(profile.ip?.length), "partial"],
    ["target_type", Boolean(profile.target_types?.length), "partial"],
    ["business_status", Boolean(profile.business_status), "complete"],
    ["tax_compliance", Boolean(profile.tax_compliance), "partial"],
    ["credit_status", Boolean(profile.credit_status), "partial"],
    ["sanction", Boolean(profile.sanction), "partial"],
    ["financial_health", Boolean(profile.financial_health), "partial"],
    ["insured_workforce", Boolean(profile.insured_workforce), "partial"],
    ["investment", Boolean(profile.investment), "partial"],
  ];
  const asOf = new Date().toISOString();
  const suppliedConfidence = profile.confidence ?? {};
  const next: CompanyProfile = {
    ...profile,
    confidence: {},
    profile_evidence: {},
  };
  for (const [dimension, present, axisCompleteness] of dimensions) {
    if (!present) continue;
    const confidence = Math.min(0.6, suppliedConfidence[dimension] ?? 0.6);
    next.confidence![dimension] = confidence;
    next.profile_evidence![dimension] = {
      sourceKind: "self_declared",
      provider: "cunote_teaser_manual",
      asOf,
      axisCompleteness,
      confidence,
    };
  }
  for (const dimension of ["revenue", "employees"] as const) {
    const state = profile.question_answer_state?.[dimension];
    if (state?.status !== "range" || next.profile_evidence?.[dimension]) continue;
    next.profile_evidence![dimension] = {
      sourceKind: "self_declared",
      provider: "cunote_profile_question_range",
      asOf: state.answeredAt,
      axisCompleteness: "partial",
      confidence: 0.6,
    };
  }
  if (Object.keys(next.confidence ?? {}).length === 0) delete next.confidence;
  if (Object.keys(next.profile_evidence ?? {}).length === 0) delete next.profile_evidence;
  return next;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeConfidence(value: unknown): NonNullable<CompanyProfile["confidence"]> {
  if (!isRecord(value)) return {};
  const confidence: NonNullable<CompanyProfile["confidence"]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const numberValue = normalizeFiniteNumber(raw, 0);
    if (numberValue === null) continue;
    confidence[key as keyof NonNullable<CompanyProfile["confidence"]>] = Math.min(0.6, numberValue);
  }
  return confidence;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return null;
  return Math.floor(numberValue);
}

function normalizeFiniteNumber(value: unknown, minimum?: number): number | null {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue) || (minimum !== undefined && numberValue < minimum)) return null;
  return numberValue;
}

function parseEvidenceDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
