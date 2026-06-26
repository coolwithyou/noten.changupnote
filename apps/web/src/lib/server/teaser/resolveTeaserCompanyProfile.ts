import type { CompanyProfile, TeaserRequest } from "@cunote/contracts";
import { loadCompanyProfileForTeaser } from "@/lib/server/serviceData";

export async function resolveTeaserCompanyProfile(body: Partial<TeaserRequest>): Promise<CompanyProfile> {
  if (isRecord(body.profile)) return normalizeManualProfile(body.profile);
  return loadCompanyProfileForTeaser(body.bizNo?.trim() || undefined);
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

  if (name) profile.name = name;
  if (region) profile.region = region;
  if (typeof input.is_preliminary === "boolean") profile.is_preliminary = input.is_preliminary;
  if (bizAgeMonths !== null) profile.biz_age_months = bizAgeMonths;
  if (founderAge !== null) profile.founder_age = founderAge;
  if (industries.length > 0) profile.industries = industries;
  if (size) profile.size = size;
  if (traits.length > 0) profile.traits = traits;
  if (certs.length > 0) profile.certs = certs;
  if (targetTypes.length > 0) profile.target_types = targetTypes;
  if (Object.keys(confidence).length > 0) profile.confidence = confidence;

  return profile;
}

function normalizeRegion(value: unknown): CompanyProfile["region"] | undefined {
  if (!isRecord(value)) return undefined;
  const code = normalizeString(value.code);
  if (!code) return undefined;
  const label = normalizeString(value.label);
  return label ? { code, label } : { code };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
