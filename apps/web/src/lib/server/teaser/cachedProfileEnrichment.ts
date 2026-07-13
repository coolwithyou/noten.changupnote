import type { CompanyProfile, CompanyProfileEvidenceObservation, CriterionDimension } from "@cunote/contracts";
import type { EnrichmentCacheEntry, EnrichmentCacheRepository } from "@cunote/core";
import { normalizeCompanyIndustryProfile } from "@cunote/core/company/profile-from-popbill";

const APICK_CACHE = { provider: "apick", scope: "bizDetail" } as const;
const STARTUP_CONFIRMATION_CACHE = { provider: "kised", scope: "startup-confirmation" } as const;
const KIPRIS_CACHE = { provider: "kipris", scope: "applicant-business-number" } as const;

export interface CachedTeaserProfileEnrichment {
  profiles: CompanyProfile[];
  providers: Array<"apick" | "startup_confirmation" | "kipris">;
}

/**
 * 개발 진단 화면에서 이미 검증·캐시한 값을 제품 매칭 프로필로 승격한다.
 * 외부 API를 새로 호출하지 않으며 캐시 장애도 기본 프로필 반환을 막지 않는다.
 */
export async function loadCachedTeaserProfileEnrichment(input: {
  cache: EnrichmentCacheRepository;
  bizNo: string;
  now?: Date;
}): Promise<CachedTeaserProfileEnrichment> {
  const now = input.now ?? new Date();
  const entries = await Promise.all([
    getFresh(input.cache, APICK_CACHE, input.bizNo, now),
    getFresh(input.cache, STARTUP_CONFIRMATION_CACHE, input.bizNo, now),
    getFresh(input.cache, KIPRIS_CACHE, input.bizNo, now),
  ]);
  return buildCachedTeaserProfileEnrichment(entries.filter((entry): entry is EnrichmentCacheEntry => entry !== null));
}

export function buildCachedTeaserProfileEnrichment(
  entries: EnrichmentCacheEntry[],
): CachedTeaserProfileEnrichment {
  const profiles: CompanyProfile[] = [];
  const providers: CachedTeaserProfileEnrichment["providers"] = [];
  for (const entry of entries) {
    const asOf = (entry.checkedAt ?? entry.fetchedAt).toISOString();
    if (entry.provider === APICK_CACHE.provider && entry.scope === APICK_CACHE.scope) {
      const profile = profileFromApickCache(entry.canonicalPayload, asOf);
      if (profile) {
        profiles.push(profile);
        providers.push("apick");
      }
      continue;
    }
    if (entry.provider === STARTUP_CONFIRMATION_CACHE.provider && entry.scope === STARTUP_CONFIRMATION_CACHE.scope) {
      const profile = profileFromStartupConfirmationCache(entry.canonicalPayload, asOf);
      if (profile) {
        profiles.push(profile);
        providers.push("startup_confirmation");
      }
      continue;
    }
    if (entry.provider === KIPRIS_CACHE.provider && entry.scope === KIPRIS_CACHE.scope) {
      const profile = profileFromKiprisCache(entry.canonicalPayload, asOf);
      if (profile) {
        profiles.push(profile);
        providers.push("kipris");
      }
    }
  }
  return { profiles, providers };
}

async function getFresh(
  cache: EnrichmentCacheRepository,
  key: { provider: string; scope: string },
  bizNo: string,
  now: Date,
): Promise<EnrichmentCacheEntry | null> {
  return cache.getFresh({ ...key, bizNo, now }).catch(() => null);
}

function profileFromApickCache(payload: Record<string, unknown> | null | undefined, asOf: string): CompanyProfile | null {
  if (!isRecord(payload) || !isRecord(payload.profile)) return null;
  let profile: CompanyProfile;
  try {
    profile = normalizeCompanyIndustryProfile(payload.profile as CompanyProfile);
  } catch {
    return null;
  }
  const apickTargetType = canonicalApickTargetType(profile.other_conditions?.apick_company_type);
  if (apickTargetType && !profile.target_types?.includes(apickTargetType)) {
    profile = { ...profile, target_types: [...(profile.target_types ?? []), apickTargetType] };
  }
  const evidence = { ...(profile.profile_evidence ?? {}) };
  const confidence = { ...(profile.confidence ?? {}) };
  setEvidence(evidence, confidence, "region", Boolean(profile.region), "apick", asOf, "complete", 0.85);
  setEvidence(evidence, confidence, "biz_age", typeof profile.biz_age_months === "number", "apick", asOf, "complete", 0.85);
  setEvidence(
    evidence,
    confidence,
    "industry",
    Boolean(profile.industries?.length || profile.industry_codes?.length),
    "apick",
    asOf,
    "partial",
    profile.industry_codes?.length ? 0.85 : 0.75,
  );
  setEvidence(evidence, confidence, "size", Boolean(profile.size), "apick", asOf, "complete", 0.7);
  setEvidence(evidence, confidence, "employees", typeof profile.employees_count === "number", "apick", asOf, "complete", 0.65);
  setEvidence(evidence, confidence, "business_status", Boolean(profile.business_status), "apick", asOf, "complete", 0.9);
  setEvidence(evidence, confidence, "target_type", Boolean(profile.target_types?.length), "apick", asOf, "partial", 0.8);
  return {
    ...profile,
    confidence,
    profile_evidence: evidence,
    ...(profile.industries?.length || profile.industry_codes?.length
      ? { list_completeness: { ...(profile.list_completeness ?? {}), industry: "partial" } }
      : {}),
  };
}

function profileFromStartupConfirmationCache(
  payload: Record<string, unknown> | null | undefined,
  asOf: string,
): CompanyProfile | null {
  if (!isRecord(payload) || payload.state !== "active" || !isRecord(payload.record)) return null;
  const issuedOn = stringOrNull(payload.record.issuedOn);
  const expiresOn = stringOrNull(payload.record.expiresOn);
  return {
    certs: ["창업기업확인서"],
    target_types: ["창업기업"],
    confidence: { certification: 0.95, target_type: 0.95 },
    list_completeness: { certification: "partial", target_type: "partial" },
    profile_evidence: {
      certification: observation("startup_confirmation", asOf, "partial", 0.95),
      target_type: observation("startup_confirmation", asOf, "partial", 0.95),
    },
    other_conditions: {
      startup_confirmation_issued_on: issuedOn,
      startup_confirmation_expires_on: expiresOn,
    },
  };
}

function profileFromKiprisCache(
  payload: Record<string, unknown> | null | undefined,
  asOf: string,
): CompanyProfile | null {
  if (!isRecord(payload) || payload.version !== 2 || payload.found !== true || !isRecord(payload.rights)) return null;
  const patentUtility = totalCount(payload.rights.patentUtility);
  const design = totalCount(payload.rights.design);
  const trademark = totalCount(payload.rights.trademark);
  const labels = [
    ...(patentUtility > 0 ? ["특허·실용신안"] : []),
    ...(design > 0 ? ["디자인"] : []),
    ...(trademark > 0 ? ["상표"] : []),
  ];
  if (labels.length === 0) return null;
  const truncated = payload.rights.truncated === true;
  const confidence = truncated ? 0.85 : 0.95;
  return {
    ip: labels,
    confidence: { ip: confidence },
    list_completeness: { ip: "partial" },
    profile_evidence: {
      ip: observation("kipris", asOf, "partial", confidence),
    },
    other_conditions: {
      kipris_patent_utility_count: patentUtility,
      kipris_design_count: design,
      kipris_trademark_count: trademark,
      kipris_truncated: truncated,
    },
  };
}

function setEvidence(
  evidence: NonNullable<CompanyProfile["profile_evidence"]>,
  confidence: NonNullable<CompanyProfile["confidence"]>,
  dimension: CriterionDimension,
  present: boolean,
  provider: string,
  asOf: string,
  axisCompleteness: "partial" | "complete",
  defaultConfidence: number,
): void {
  if (!present) return;
  const value = confidence[dimension] ?? defaultConfidence;
  confidence[dimension] = value;
  evidence[dimension] = observation(provider, asOf, axisCompleteness, value);
}

function observation(
  provider: string,
  asOf: string,
  axisCompleteness: "partial" | "complete",
  confidence: number,
): CompanyProfileEvidenceObservation {
  return { sourceKind: "authoritative_api", provider, asOf, axisCompleteness, confidence };
}

function totalCount(value: unknown): number {
  if (!isRecord(value) || typeof value.totalCount !== "number" || !Number.isFinite(value.totalCount)) return 0;
  return Math.max(0, Math.trunc(value.totalCount));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalApickTargetType(value: unknown): "법인" | "개인사업자" | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, "");
  if (normalized.includes("법인")) return "법인";
  if (normalized.includes("개인")) return "개인사업자";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
