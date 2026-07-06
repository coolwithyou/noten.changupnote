import type { CompanyEvidence, CompanyProfile, TeaserRequest } from "@cunote/contracts";
import { buildCompanyEvidence, loadCompanyProfileResolutionForTeaser } from "@/lib/server/serviceData";

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
      const profile = mergeManualProfile(base.profile, manualProfile);
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

function normalizeManualProfile(input: Record<string, unknown>): CompanyProfile {
  const profile: CompanyProfile = {};
  const region = normalizeRegion(input.region);
  const industries = normalizeStringArray(input.industries);
  const traits = normalizeStringArray(input.traits);
  const certs = normalizeStringArray(input.certs);
  const targetTypes = normalizeStringArray(input.target_types);
  const confidence = normalizeConfidence(input.confidence);

  const name = normalizeString(input.name);
  const size = normalizeString(input.size);
  const bizAgeMonths = normalizeNonNegativeNumber(input.biz_age_months);
  const founderAge = normalizeNonNegativeNumber(input.founder_age);
  const revenue = normalizeNonNegativeNumber(input.revenue_krw);
  const employees = normalizeNonNegativeNumber(input.employees_count);
  const businessStatus = normalizeBusinessStatus(input.business_status);

  if (name) profile.name = name;
  if (region) profile.region = region;
  if (typeof input.is_preliminary === "boolean") profile.is_preliminary = input.is_preliminary;
  if (bizAgeMonths !== null) profile.biz_age_months = bizAgeMonths;
  if (founderAge !== null) profile.founder_age = founderAge;
  if (revenue !== null) profile.revenue_krw = revenue;
  if (employees !== null) profile.employees_count = employees;
  if (industries.length > 0) profile.industries = industries;
  if (size) profile.size = size;
  if (traits.length > 0) profile.traits = traits;
  if (certs.length > 0) profile.certs = certs;
  if (targetTypes.length > 0) profile.target_types = targetTypes;
  if (businessStatus) profile.business_status = businessStatus;
  if (Object.keys(confidence).length > 0) profile.confidence = confidence;

  return profile;
}

function mergeManualProfile(base: CompanyProfile, manual: CompanyProfile): CompanyProfile {
  const profile: CompanyProfile = {
    ...base,
    confidence: {
      ...(base.confidence ?? {}),
      ...(manual.confidence ?? {}),
    },
  };

  if (manual.name) profile.name = manual.name;
  if (manual.region) profile.region = manual.region;
  if (manual.biz_age_months !== null && manual.biz_age_months !== undefined) profile.biz_age_months = manual.biz_age_months;
  if (manual.founder_age !== null && manual.founder_age !== undefined) profile.founder_age = manual.founder_age;
  if (manual.revenue_krw !== null && manual.revenue_krw !== undefined) profile.revenue_krw = manual.revenue_krw;
  if (manual.employees_count !== null && manual.employees_count !== undefined) profile.employees_count = manual.employees_count;
  if (manual.is_preliminary !== undefined) profile.is_preliminary = manual.is_preliminary;
  if (manual.industries?.length) profile.industries = manual.industries;
  if (manual.industry_codes?.length) profile.industry_codes = manual.industry_codes;
  if (manual.size) profile.size = manual.size;
  if (manual.traits?.length) profile.traits = manual.traits;
  if (manual.certs?.length) profile.certs = manual.certs;
  if (manual.prior_awards?.length) profile.prior_awards = manual.prior_awards;
  if (manual.ip?.length) profile.ip = manual.ip;
  if (manual.target_types?.length) profile.target_types = manual.target_types;
  if (manual.other_conditions) profile.other_conditions = manual.other_conditions;
  if (manual.business_status) profile.business_status = manual.business_status;

  return profile;
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
    const numberValue = normalizeNonNegativeNumber(raw);
    if (numberValue === null) continue;
    confidence[key as keyof NonNullable<CompanyProfile["confidence"]>] = Math.min(1, numberValue);
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

function parseEvidenceDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
