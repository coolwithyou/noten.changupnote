import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApplySheet,
  buildDashboard,
  deriveGrantBenefits,
  fetchKStartupPage,
  normalizeKStartupPayload,
} from "@cunote/core";
import { buildCompanyProfileFromPopbill } from "@cunote/core/company/profile-from-popbill";
import {
  checkPopbillBizInfo,
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "@cunote/core/popbill/check-biz-info";
import type {
  ApplySheet,
  CompanyEnrichmentFacts,
  CompanyEnrichmentResult,
  CompanyEvidence,
  CompanyProfile,
  GrantBenefit,
  NormalizedGrant,
} from "@cunote/contracts";
import type { DashboardResult } from "@cunote/contracts";
import type { BizInfoProgram, KStartupAnnouncement, KStartupApiResponse } from "@cunote/core";
import { createServiceRepositories, getRepositoryAdapterName } from "./repositories/factory";
import { buildBizInfoSampleEntries } from "./ingestion/bizinfoSample";
import { refreshMatchStates } from "./matches/matchStateRefresh";
import { notifyPopbillFailure } from "./adminNotifications";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";
const ENRICHMENT_CACHE_PROVIDER = "popbill";
const ENRICHMENT_CACHE_SCOPE = "checkBizInfo";
const ENRICHMENT_CACHE_TTL_HOURS_ENV = "CUNOTE_POPBILL_CACHE_TTL_HOURS";
// 팝빌 조회는 사업자당 과금이므로 기본 90일 동안 DB 캐시를 재사용한다.
// 90일이 지나면 다음 조회 시 팝빌을 1회 다시 호출해 최신 상태(휴·폐업/주소 변경 등)로 갱신한다.
// CUNOTE_POPBILL_CACHE_TTL_HOURS로 기간을 조정할 수 있고, 0 이하로 두면 무기한 캐시(재조회 없음)로 동작한다.
const DEFAULT_ENRICHMENT_CACHE_TTL_HOURS = 24 * 90;

// 동일 사업자번호에 대한 동시 조회를 하나의 팝빌 호출로 합쳐 중복 과금을 막는다(in-flight 요청 dedup).
const inflightPopbillLookups = new Map<string, Promise<PopbillCompanyResolution>>();

type ServiceGrantPayload = KStartupAnnouncement | BizInfoProgram;
type PopbillCredentials = ReturnType<typeof readPopbillEnvConfig>["credentials"];

interface CompanyProfileResolution {
  profile: CompanyProfile;
  evidence: CompanyEvidence | null;
}

interface PopbillCompanyResolution {
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
  evidence: CompanyEvidence;
}

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
      return withDerivedBenefits(appendBizInfoSampleIfNeeded(kstartupEntries, {
        include: includeBizInfoSample,
        usedSample,
        limit,
        asOf,
      }));
    } catch (error) {
      console.warn(`K-Startup live fetch failed. Falling back to sample data: ${errorMessage(error)}`);
    }
  }

  usedSample = true;
  const sample = readKStartupSample();
  const rows = sample.data.slice(0, kstartupLimit);
  kstartupEntries = normalizeKStartupPayload(rows, { asOf });
  return withDerivedBenefits(appendBizInfoSampleIfNeeded(kstartupEntries, {
    include: includeBizInfoSample,
    usedSample,
    limit,
    asOf,
  }));
}

export async function loadCompanyProfileForTeaser(bizNo?: string): Promise<CompanyProfile> {
  return (await loadCompanyProfileResolutionForTeaser(bizNo)).profile;
}

export async function loadCompanyProfileResolutionForTeaser(
  bizNo?: string,
  options: { asOf?: Date } = {},
): Promise<CompanyProfileResolution> {
  const asOf = options.asOf ?? new Date();
  if (bizNo) {
    const normalizedBizNo = sanitizeCorpNum(bizNo);
    const savedProfile = await repositories.companies.resolveCompanyProfile({ bizNo: normalizedBizNo });
    if (savedProfile) {
      return {
        profile: savedProfile,
        evidence: buildCompanyEvidence({
          provider: "internal",
          source: "saved_profile",
          cacheStatus: "none",
          profile: savedProfile,
          summary: "저장된 회사 프로필로 매칭했습니다.",
        }),
      };
    }
    return loadCompanyProfileFromSourceWithEvidence(normalizedBizNo, { asOf });
  }

  const profile = await repositories.companies.resolveCompanyProfile({});
  if (!profile) {
    throw new Error("회사 프로필을 찾지 못했습니다.");
  }
  return {
    profile,
    evidence: buildCompanyEvidence({
      provider: "internal",
      source: "saved_profile",
      cacheStatus: "none",
      profile,
      summary: "저장된 회사 프로필로 매칭했습니다.",
    }),
  };
}

async function loadCompanyProfileFromSource(bizNo?: string): Promise<CompanyProfile> {
  return (await loadCompanyProfileFromSourceWithEvidence(bizNo)).profile;
}

async function loadCompanyProfileFromSourceWithEvidence(
  bizNo?: string,
  options: { asOf?: Date } = {},
): Promise<CompanyProfileResolution> {
  await loadEnvInDevelopment();

  const requestedBizNo = bizNo ? sanitizeCorpNum(bizNo) : null;
  const asOf = options.asOf ?? new Date();
  try {
    const popbill = readPopbillEnvConfig();
    const checkCorpNum = requestedBizNo ?? popbill.checkCorpNum;
    const result = await loadPopbillCompanyProfile({
      bizNo: checkCorpNum,
      credentials: popbill.credentials,
      asOf,
      now: new Date(),
    });
    return {
      profile: result.profile,
      evidence: result.evidence,
    };
  } catch (error) {
    if (requestedBizNo) {
      // 가드/캐시 검증 등 의미가 분명한 오류는 원래 코드(popbill_cache_unavailable 등)를 보존하고
      // 팝빌 장애 알림도 보내지 않는다(DB 문제를 팝빌 실패로 오인하지 않도록).
      if (error instanceof ServiceDataError) {
        console.warn(`Popbill lookup skipped for requested biz no: ${error.code} - ${error.message}`);
        throw error;
      }
      console.warn(`Popbill profile fetch failed for requested biz no: ${errorMessage(error)}`);
      await notifyPopbillFailure({
        surface: "teaser",
        bizNo: requestedBizNo,
        error,
      });
      throw new ServiceDataError(
        "popbill_lookup_failed",
        "사업자 정보를 즉시 확인하지 못했습니다. 사업자번호를 다시 확인하거나 잠시 후 다시 시도해주세요.",
        503,
        "bizNo",
      );
    }
    console.warn(`Popbill profile fetch failed. Falling back to sample company: ${errorMessage(error)}`);
  }

  const profile = sampleCompanyProfile();
  return {
    profile,
    evidence: sampleCompanyEvidence(profile),
  };
}

export async function loadServiceDashboard(options: {
  companyId?: string;
  userId?: string;
  limit?: number;
  asOf?: Date;
  writeMatchStates?: boolean;
} = {}): Promise<DashboardResult> {
  const asOf = options.asOf ?? new Date();
  const [company, grants] = await Promise.all([
    resolveDashboardCompany(options.companyId, options.userId),
    repositories.grants.listActiveGrants({ asOf, limit: options.limit ?? 40 }),
  ]);
  const stateCompanyId = options.companyId ?? company.id;
  if (options.writeMatchStates !== false) {
    await persistMatchStates({
      ...(stateCompanyId ? { companyId: stateCompanyId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      company,
      grants,
      asOf,
    });
  }

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

  let resolved: PopbillCompanyResolution;
  try {
    const popbill = readPopbillEnvConfig();
    resolved = await loadPopbillCompanyProfile({
      bizNo,
      credentials: popbill.credentials,
      asOf,
      now,
    });
  } catch (error) {
    console.warn(`Popbill company enrichment failed: ${errorMessage(error)}`);
    await notifyPopbillFailure({
      surface: "company_enrichment",
      bizNo,
      error,
      at: now,
    });
    throw error;
  }
  const profile = mergeCompanyProfilesForEnrichment(current, resolved.profile);
  const saved = await repositories.companies.saveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
    profile,
  });

  return {
    profile: saved,
    facts: resolved.facts,
    evidence: resolved.evidence,
  };
}

function loadPopbillCompanyProfile(input: {
  bizNo: string;
  credentials: PopbillCredentials;
  asOf: Date;
  now: Date;
}): Promise<PopbillCompanyResolution> {
  // 동일 사업자번호 동시 요청은 진행 중인 조회 하나에 합류시켜 팝빌 중복 호출(중복 과금)을 방지한다.
  const key = `${ENRICHMENT_CACHE_PROVIDER}:${ENRICHMENT_CACHE_SCOPE}:${input.bizNo}`;
  const existing = inflightPopbillLookups.get(key);
  if (existing) return existing;

  const task = fetchPopbillCompanyProfile(input).finally(() => {
    inflightPopbillLookups.delete(key);
  });
  inflightPopbillLookups.set(key, task);
  return task;
}

async function fetchPopbillCompanyProfile(input: {
  bizNo: string;
  credentials: PopbillCredentials;
  asOf: Date;
  now: Date;
}): Promise<PopbillCompanyResolution> {
  // 가드 1: 캐시가 영속 저장되는 DB(drizzle) 어댑터가 아니면(=in-memory) 매 조회가 과금되므로 팝빌 호출을 차단한다.
  if (getRepositoryAdapterName() !== "drizzle") {
    throw new ServiceDataError(
      "popbill_cache_unavailable",
      "사업자 정보 캐시 저장소(DB)가 구성되지 않아 조회를 진행할 수 없습니다. DATABASE_URL / CUNOTE_REPOSITORY_ADAPTER 설정을 확인해주세요.",
      503,
      "bizNo",
    );
  }

  // 가드 2: 캐시 조회(DB read)가 실패하면 캐시 저장도 불가하므로, 과금을 막기 위해 팝빌 호출을 차단한다.
  let cached: Awaited<ReturnType<typeof repositories.enrichmentCache.getFresh>>;
  try {
    cached = await repositories.enrichmentCache.getFresh({
      provider: ENRICHMENT_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: ENRICHMENT_CACHE_SCOPE,
      now: input.now,
    });
  } catch (error) {
    console.warn(`Popbill 조회 차단: 캐시 DB 접속 실패 - ${errorMessage(error)}`);
    throw new ServiceDataError(
      "popbill_cache_unavailable",
      "사업자 정보 캐시 저장소(DB)에 접속할 수 없어 조회를 진행할 수 없습니다. 잠시 후 다시 시도해주세요.",
      503,
      "bizNo",
    );
  }
  const cachedCanonical = parseCachedCompanyEnrichment(cached?.canonicalPayload);
  if (cachedCanonical) {
    return {
      profile: cachedCanonical.profile,
      facts: cachedCanonical.facts,
      evidence: buildCompanyEvidence({
        provider: "popbill",
        source: "popbill_cache",
        cacheStatus: "hit",
        profile: cachedCanonical.profile,
        facts: cachedCanonical.facts,
        checkedAt: cached?.checkedAt ?? parseProviderCheckedAt(cachedCanonical.facts.checkedAt),
        cachedUntil: cached?.expiresAt ?? null,
        summary: "저장된 팝빌 조회 결과를 재사용해 회사 정보를 바로 확인했습니다.",
      }),
    };
  }

  const info = await checkPopbillBizInfo({
    credentials: input.credentials,
    checkCorpNum: input.bizNo,
  });
  if (String(info.result) !== "100") {
    throw new ServiceDataError(
      "company_enrichment_failed",
      "팝빌에서 사업자 정보를 확인하지 못했습니다. 사업자번호를 다시 확인하거나 잠시 후 다시 시도해주세요.",
      502,
      "bizNo",
    );
  }

  const enriched = buildCompanyProfileFromPopbill(info, { asOf: input.asOf });
  const facts = toCompanyEnrichmentFacts(enriched.facts);
  const canonicalPayload: Record<string, unknown> = {
    profile: enriched.profile,
    facts,
  };
  const checkedAt = parseProviderCheckedAt(facts.checkedAt);
  const expiresAt = resolvePopbillCacheExpiresAt(input.now);
  let cacheStatus: CompanyEvidence["cacheStatus"] = "stored";
  let cachedUntil: Date | null = expiresAt;

  try {
    await repositories.enrichmentCache.put({
      provider: ENRICHMENT_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: ENRICHMENT_CACHE_SCOPE,
      // 팝빌 응답 본문 전체를 원본 그대로 보존한다(향후 재가공/감사/스키마 변경 대비).
      rawPayload: info as Record<string, unknown>,
      canonicalPayload,
      providerResultCode: String(info.result),
      providerResultMessage: facts.resultMessage,
      checkedAt,
      fetchedAt: input.now,
      expiresAt,
      payloadHash: hashCanonicalPayload(canonicalPayload),
    });
  } catch (error) {
    cacheStatus = "none";
    cachedUntil = null;
    console.warn(`Company enrichment cache write failed: ${errorMessage(error)}`);
  }

  return {
    profile: enriched.profile,
    facts,
    evidence: buildCompanyEvidence({
      provider: "popbill",
      source: "popbill_live",
      cacheStatus,
      profile: enriched.profile,
      facts,
      checkedAt: checkedAt ?? input.now,
      cachedUntil,
      summary: cacheStatus === "stored"
        ? "팝빌에서 사업자 정보를 확인했고 다음 조회부터 추가 조회 없이 저장 결과를 재사용합니다."
        : "팝빌에서 사업자 정보를 확인했습니다.",
    }),
  };
}

function resolvePopbillCacheExpiresAt(now: Date): Date | null {
  const rawTtlHours = process.env[ENRICHMENT_CACHE_TTL_HOURS_ENV]?.trim();
  const ttlHours = rawTtlHours ? Number(rawTtlHours) : DEFAULT_ENRICHMENT_CACHE_TTL_HOURS;
  // 0 이하 또는 유효하지 않은 값이면 무기한 캐시(만료 없음)로 둔다.
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return null;
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

export function buildCompanyEvidence(input: {
  provider: CompanyEvidence["provider"];
  source: CompanyEvidence["source"];
  cacheStatus: CompanyEvidence["cacheStatus"];
  profile: CompanyProfile;
  facts?: CompanyEnrichmentFacts;
  checkedAt?: Date | null;
  cachedUntil?: Date | null;
  maskedBizNo?: string | null;
  resultMessage?: string | null;
  summary: string;
}): CompanyEvidence {
  const facts = input.facts;
  return {
    provider: input.provider,
    source: input.source,
    cacheStatus: input.cacheStatus,
    checkedAt: input.checkedAt?.toISOString() ?? null,
    cachedUntil: input.cachedUntil?.toISOString() ?? null,
    maskedBizNo: input.maskedBizNo ?? facts?.maskedBizNo ?? null,
    resultMessage: input.resultMessage ?? facts?.resultMessage ?? null,
    fields: buildCompanyEvidenceFields(input.profile, facts),
    summary: input.summary,
  };
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
  await refreshMatchStates({
    repositories,
    company: input.company,
    grants: input.grants,
    asOf: input.asOf,
    companyId: input.companyId,
    ...(input.userId ? { userId: input.userId } : {}),
    write: true,
  });
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

function withDerivedBenefits<TPayload extends ServiceGrantPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
): Array<NormalizedGrant<TPayload>> {
  return entries.map((entry) => {
    if (entry.grant.benefits?.length) return entry;
    const benefits = deriveGrantBenefits(entry.grant).map((benefit): GrantBenefit => ({
      family: benefit.family,
      label: benefit.label,
      source: benefit.source,
      confidence: benefit.confidence,
    }));
    return {
      ...entry,
      grant: {
        ...entry.grant,
        benefits,
      },
    };
  });
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

function sampleCompanyEvidence(profile: CompanyProfile): CompanyEvidence {
  return buildCompanyEvidence({
    provider: "sample",
    source: "sample_profile",
    cacheStatus: "none",
    profile,
    summary: "팝빌 조회를 사용할 수 없어 개발용 샘플 회사 프로필로 매칭했습니다.",
  });
}

function buildCompanyEvidenceFields(
  profile: CompanyProfile,
  facts?: CompanyEnrichmentFacts,
): CompanyEvidence["fields"] {
  return [
    {
      key: "corp_name",
      label: "상호",
      available: facts?.hasCorpName ?? Boolean(profile.name),
      value: profile.name ?? null,
    },
    {
      key: "region",
      label: "소재지",
      available: facts?.hasRegion ?? Boolean(profile.region?.label ?? profile.region?.code),
      value: profile.region?.label ?? profile.region?.code ?? null,
    },
    {
      key: "biz_age",
      label: "업력",
      available: facts?.hasBizAge ?? (profile.biz_age_months !== null && profile.biz_age_months !== undefined),
      value: formatBizAgeMonths(profile.biz_age_months),
    },
    {
      key: "size",
      label: "기업규모",
      available: facts?.hasSize ?? Boolean(profile.size),
      value: profile.size ?? null,
    },
    {
      key: "industry",
      label: "업종",
      available: facts?.hasIndustry ?? Boolean(profile.industries?.length),
      value: profile.industries?.length ? profile.industries.join(", ") : null,
    },
    {
      key: "business_status",
      label: "영업상태",
      available: Boolean(
        profile.business_status?.label ||
        facts?.closeDownState !== null && facts?.closeDownState !== undefined ||
        facts?.closeDownTaxType !== null && facts?.closeDownTaxType !== undefined
      ),
      value: profile.business_status?.label ?? null,
    },
  ];
}

function formatBizAgeMonths(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value < 12) return `${value}개월`;
  const years = Math.floor(value / 12);
  const months = value % 12;
  return months > 0 ? `${years}년 ${months}개월` : `${years}년`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "unknown error";
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
