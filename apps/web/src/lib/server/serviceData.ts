import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApplySheet,
  buildDashboard,
  buildCompanyProfileFromPopbill,
  checkPopbillBizInfo,
  fetchKStartupPage,
  normalizeKStartupPayload,
  planMatchStateRefresh,
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core";
import type { ApplySheet, CompanyEnrichmentFacts, CompanyEnrichmentResult, CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import type { DashboardResult } from "@cunote/contracts";
import type { BizInfoProgram, KStartupAnnouncement, KStartupApiResponse } from "@cunote/core";
import { createServiceRepositories } from "./repositories/factory";
import { buildBizInfoSampleEntries } from "./ingestion/bizinfoSample";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";
const ENRICHMENT_CACHE_PROVIDER = "popbill";
const ENRICHMENT_CACHE_SCOPE = "checkBizInfo";
const ENRICHMENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type ServiceGrantPayload = KStartupAnnouncement | BizInfoProgram;

const repositories = createServiceRepositories<ServiceGrantPayload>({
  loadGrants: loadServiceGrantsFromSource,
  loadCompanyProfile: loadCompanyProfileFromSource,
});

export interface LoadServiceGrantsOptions {
  limit?: number;
  asOf?: Date;
}

export async function loadServiceGrants({
  limit = 20,
  asOf = new Date(),
}: LoadServiceGrantsOptions = {}): Promise<Array<NormalizedGrant<ServiceGrantPayload>>> {
  return repositories.grants.listActiveGrants({ limit, asOf });
}

async function loadServiceGrantsFromSource({
  limit = 20,
  asOf = new Date(),
}: LoadServiceGrantsOptions = {}): Promise<Array<NormalizedGrant<ServiceGrantPayload>>> {
  await loadEnvInDevelopment();

  const source = process.env.CUNOTE_WEB_DATA_SOURCE?.trim().toLowerCase();
  const serviceKey = process.env.KSTARTUP_SERVICE_KEY?.trim();
  const includeBizInfoSample = shouldIncludeBizInfoSample(source);
  const kstartupLimit = includeBizInfoSample && limit > 1 ? limit - 1 : limit;
  let kstartupEntries: Array<NormalizedGrant<KStartupAnnouncement>>;
  let usedSample = false;

  if (source !== "sample" && serviceKey) {
    try {
      const payload = await fetchKStartupPage({
        serviceKey,
        page: 1,
        perPage: kstartupLimit,
      });
      kstartupEntries = normalizeKStartupPayload(payload, { asOf });
      return appendBizInfoSampleIfNeeded(kstartupEntries, {
        include: includeBizInfoSample,
        usedSample,
        limit,
        asOf,
      });
    } catch (error) {
      console.warn(`K-Startup live fetch failed. Falling back to sample data: ${errorMessage(error)}`);
    }
  }

  usedSample = true;
  const sample = readKStartupSample();
  const rows = sample.data.slice(0, kstartupLimit);
  kstartupEntries = normalizeKStartupPayload(rows, { asOf });
  return appendBizInfoSampleIfNeeded(kstartupEntries, {
    include: includeBizInfoSample,
    usedSample,
    limit,
    asOf,
  });
}

export async function loadCompanyProfileForTeaser(bizNo?: string): Promise<CompanyProfile> {
  const profile = await repositories.companies.resolveCompanyProfile(bizNo ? { bizNo } : {});
  if (!profile) {
    throw new Error("회사 프로필을 찾지 못했습니다.");
  }
  return profile;
}

async function loadCompanyProfileFromSource(bizNo?: string): Promise<CompanyProfile> {
  await loadEnvInDevelopment();

  const requestedBizNo = bizNo ? sanitizeCorpNum(bizNo) : null;
  try {
    const popbill = readPopbillEnvConfig();
    const checkCorpNum = requestedBizNo ?? popbill.checkCorpNum;
    const info = await checkPopbillBizInfo({
      credentials: popbill.credentials,
      checkCorpNum,
    });
    if (String(info.result) === "100") {
      return buildCompanyProfileFromPopbill(info).profile;
    }
    console.warn(`Popbill checkBizInfo returned non-success result: ${info.result ?? "unknown"}`);
  } catch (error) {
    if (requestedBizNo) throw error;
    console.warn(`Popbill profile fetch failed. Falling back to sample company: ${errorMessage(error)}`);
  }

  return sampleCompanyProfile();
}

export async function loadServiceDashboard(options: {
  companyId?: string;
  userId?: string;
  limit?: number;
  asOf?: Date;
} = {}): Promise<DashboardResult> {
  const asOf = options.asOf ?? new Date();
  const [company, grants] = await Promise.all([
    resolveDashboardCompany(options.companyId, options.userId),
    repositories.grants.listActiveGrants({ asOf, limit: options.limit ?? 40 }),
  ]);
  const stateCompanyId = options.companyId ?? company.id;
  await persistMatchStates({
    ...(stateCompanyId ? { companyId: stateCompanyId } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
    company,
    grants,
    asOf,
  });

  return buildDashboard({ company, grants, asOf, limit: options.limit ?? 24 });
}

export async function loadServiceApplySheet(
  grantIdSegment: string,
  options: {
    companyId?: string;
    userId?: string;
    limit?: number;
    asOf?: Date;
  } = {},
): Promise<ApplySheet | null> {
  const asOf = options.asOf ?? new Date();
  const grantId = decodeGrantIdSegment(grantIdSegment);
  const [company, grants] = await Promise.all([
    resolveDashboardCompany(options.companyId, options.userId),
    repositories.grants.findGrantById(grantId, { asOf, limit: options.limit ?? 80 }),
  ]);
  if (!grants) return null;
  const match = await repositories.matches.calculateGrantMatch({ company, grant: grants });

  return buildApplySheet({
    entry: {
      item: grants,
      match,
    },
    company,
    asOf,
  });
}

export async function enrichServiceCompany(input: {
  companyId: string;
  userId: string;
  bizNo: string;
  asOf?: Date;
}): Promise<CompanyEnrichmentResult> {
  await loadEnvInDevelopment();

  const now = new Date();
  const asOf = input.asOf ?? now;
  const bizNo = sanitizeCorpNum(input.bizNo);
  const current = await repositories.companies.resolveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
  });
  if (!current) {
    throw new ServiceDataError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");
  }

  const cached = await repositories.enrichmentCache.getFresh({
    provider: ENRICHMENT_CACHE_PROVIDER,
    bizNo,
    scope: ENRICHMENT_CACHE_SCOPE,
    now,
  });
  const cachedCanonical = parseCachedCompanyEnrichment(cached?.canonicalPayload);
  if (cachedCanonical) {
    const profile = mergeCompanyProfilesForEnrichment(current, cachedCanonical.profile);
    const saved = await repositories.companies.saveCompanyProfile({
      companyId: input.companyId,
      userId: input.userId,
      profile,
    });
    return {
      profile: saved,
      facts: cachedCanonical.facts,
    };
  }

  const popbill = readPopbillEnvConfig();
  const info = await checkPopbillBizInfo({
    credentials: popbill.credentials,
    checkCorpNum: bizNo,
  });
  if (String(info.result) !== "100") {
    throw new ServiceDataError(
      "company_enrichment_failed",
      `기업정보조회가 성공하지 못했습니다: ${String(info.result ?? "unknown")}`,
      502,
    );
  }

  const enriched = buildCompanyProfileFromPopbill(info, { asOf });
  const facts = toCompanyEnrichmentFacts(enriched.facts);
  const profile = mergeCompanyProfilesForEnrichment(current, enriched.profile);
  const saved = await repositories.companies.saveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
    profile,
  });

  const canonicalPayload: Record<string, unknown> = {
    profile: enriched.profile,
    facts,
  };
  await repositories.enrichmentCache.put({
    provider: ENRICHMENT_CACHE_PROVIDER,
    bizNo,
    scope: ENRICHMENT_CACHE_SCOPE,
    rawPayload: null,
    canonicalPayload,
    providerResultCode: String(info.result),
    providerResultMessage: facts.resultMessage,
    checkedAt: parseProviderCheckedAt(facts.checkedAt),
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + ENRICHMENT_CACHE_TTL_MS),
    payloadHash: hashCanonicalPayload(canonicalPayload),
  }).catch((error) => {
    console.warn(`Company enrichment cache write failed: ${errorMessage(error)}`);
  });

  return { profile: saved, facts };
}

export function getServiceRepositories() {
  return repositories;
}

async function resolveDashboardCompany(companyId?: string, userId?: string): Promise<CompanyProfile> {
  if (!companyId) return repositories.companies.getDefaultCompanyProfile();
  const company = await repositories.companies.resolveCompanyProfile({
    companyId,
    ...(userId ? { userId } : {}),
  });
  if (!company) throw new Error("회사 프로필을 찾지 못했습니다.");
  return company;
}

async function persistMatchStates(input: {
  companyId?: string;
  userId?: string;
  company: CompanyProfile;
  grants: Array<NormalizedGrant<ServiceGrantPayload>>;
  asOf: Date;
}) {
  if (!input.companyId) return;
  const refreshPlan = planMatchStateRefresh({
    company: input.company,
    grants: input.grants,
    asOf: input.asOf,
    companyId: input.companyId,
  });

  await Promise.all(refreshPlan.states.map((state) => {
    return repositories.matches.saveMatchState({
      companyId: input.companyId!,
      grantId: state.grantId,
      match: state.match,
      eligibleFrom: parsePlanDate(state.eligibleFrom),
      eligibleUntil: parsePlanDate(state.eligibleUntil),
      ...(input.userId ? { userId: input.userId } : {}),
    });
  }));
}

function parsePlanDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadEnvInDevelopment() {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("./loadMonorepoEnv");
    loadMonorepoEnv();
  }
}

function readKStartupSample(): KStartupApiResponse {
  const path = findProjectFile(SAMPLE_PATH);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as KStartupApiResponse;
  if (!Array.isArray(parsed.data)) {
    throw new Error(`Invalid K-Startup sample shape: ${path}`);
  }
  return parsed;
}

function appendBizInfoSampleIfNeeded(
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
  options: {
    include: boolean;
    usedSample: boolean;
    limit: number;
    asOf: Date;
  },
): Array<NormalizedGrant<ServiceGrantPayload>> {
  const shouldAppend = options.include || (options.usedSample && process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE !== "false");
  if (!shouldAppend || options.limit <= 1) return entries;

  return [
    ...entries,
    ...buildBizInfoSampleEntries({ asOf: options.asOf, collectedAt: options.asOf }),
  ].slice(0, options.limit);
}

function shouldIncludeBizInfoSample(source: string | undefined): boolean {
  const explicit = process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return source === "sample";
}

function findProjectFile(relativePath: string): string {
  const candidates = [
    resolve(/*turbopackIgnore: true*/ process.cwd(), relativePath),
    resolve(/*turbopackIgnore: true*/ process.cwd(), "../..", relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Missing project file: ${relativePath}`);
  }
  return found;
}

function decodeGrantIdSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sampleCompanyProfile(): CompanyProfile {
  return {
    name: "샘플 기업",
    region: { code: "41", label: "경기" },
    biz_age_months: 26,
    founder_age: null,
    industries: ["ICT", "SaaS", "기술기반"],
    size: "중소",
    business_status: { active: true, label: "정상" },
    confidence: {
      region: 0.7,
      biz_age: 0.7,
      founder_age: 0.5,
      industry: 0.4,
      size: 0.4,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export class ServiceDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ServiceDataError";
  }
}

export function mergeCompanyProfilesForEnrichment(current: CompanyProfile, enriched: CompanyProfile): CompanyProfile {
  const next: CompanyProfile = {
    ...current,
    confidence: {
      ...(current.confidence ?? {}),
      ...(enriched.confidence ?? {}),
    },
  };

  if (enriched.name) next.name = enriched.name;
  if (enriched.region) next.region = enriched.region;
  if (enriched.biz_age_months !== null && enriched.biz_age_months !== undefined) {
    next.biz_age_months = enriched.biz_age_months;
  }
  if (enriched.founder_age !== null && enriched.founder_age !== undefined) {
    next.founder_age = enriched.founder_age;
  }
  if (enriched.is_preliminary !== undefined) next.is_preliminary = enriched.is_preliminary;
  if (enriched.industries?.length) next.industries = enriched.industries;
  if (enriched.size) next.size = enriched.size;
  if (enriched.traits?.length) next.traits = enriched.traits;
  if (enriched.certs?.length) next.certs = enriched.certs;
  if (enriched.prior_awards?.length) next.prior_awards = enriched.prior_awards;
  if (enriched.business_status) next.business_status = enriched.business_status;

  return next;
}

function toCompanyEnrichmentFacts(
  facts: ReturnType<typeof buildCompanyProfileFromPopbill>["facts"],
): CompanyEnrichmentFacts {
  return {
    maskedBizNo: facts.masked_biz_no,
    result: facts.result,
    resultMessage: facts.result_message,
    checkedAt: facts.check_dt,
    hasCorpName: facts.has_corp_name,
    hasRegion: facts.has_region,
    hasBizAge: facts.has_biz_age,
    hasSize: facts.has_size,
    hasIndustry: facts.has_industry,
    closeDownState: facts.close_down_state,
    closeDownTaxType: facts.close_down_tax_type,
  };
}

function parseCachedCompanyEnrichment(
  payload: Record<string, unknown> | null | undefined,
): { profile: CompanyProfile; facts: CompanyEnrichmentFacts } | null {
  if (!payload) return null;
  const profile = payload.profile;
  const facts = payload.facts;
  if (!isRecord(profile) || !isRecord(facts)) return null;
  const parsedFacts = parseCachedCompanyEnrichmentFacts(facts);
  if (!parsedFacts) return null;
  return {
    profile: profile as CompanyProfile,
    facts: parsedFacts,
  };
}

function parseCachedCompanyEnrichmentFacts(input: Record<string, unknown>): CompanyEnrichmentFacts | null {
  const hasCorpName = booleanValue(input.hasCorpName);
  const hasRegion = booleanValue(input.hasRegion);
  const hasBizAge = booleanValue(input.hasBizAge);
  const hasSize = booleanValue(input.hasSize);
  const hasIndustry = booleanValue(input.hasIndustry);
  if (
    hasCorpName === null ||
    hasRegion === null ||
    hasBizAge === null ||
    hasSize === null ||
    hasIndustry === null
  ) {
    return null;
  }

  return {
    maskedBizNo: nullableStringValue(input.maskedBizNo),
    result: nullableStringOrNumberValue(input.result),
    resultMessage: nullableStringValue(input.resultMessage),
    checkedAt: nullableStringValue(input.checkedAt),
    hasCorpName,
    hasRegion,
    hasBizAge,
    hasSize,
    hasIndustry,
    closeDownState: nullableStringOrNumberValue(input.closeDownState),
    closeDownTaxType: nullableStringOrNumberValue(input.closeDownTaxType),
  };
}

function parseProviderCheckedAt(value: string | null): Date | null {
  if (!value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hashCanonicalPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJsonValue(payload)))
    .digest("hex");
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableStringOrNumberValue(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}
