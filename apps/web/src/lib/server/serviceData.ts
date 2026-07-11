import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApplySheet,
  buildDashboard,
  checkNtsBusinessStatus,
  checkSmppCertificates,
  classifyNtsBusinessStatus,
  deriveGrantBenefits,
  fetchKStartupPage,
  normalizeKStartupPayload,
} from "@cunote/core";
import {
  buildCompanyProfileFromPopbill,
  isLikelyKsicCode,
  ksicDivisionLabel,
  ksicSectionLabel,
  normalizeCompanyIndustryProfile,
} from "@cunote/core/company/profile-from-popbill";
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
import type { BizInfoProgram, KStartupAnnouncement, KStartupApiResponse, NtsBusinessStatusClassification, NtsBusinessStatusData, SmppCertificates } from "@cunote/core";
import { createServiceRepositories, getRepositoryAdapterName } from "./repositories/factory";
import { annotateHwpxTemplateAvailability } from "./documents/draftHwpxExport";
import { buildBizInfoSampleEntries } from "./ingestion/bizinfoSample";
import { annotateMatchCardWriteSupport } from "./matches/annotateWriteSupport";
import { refreshMatchStates } from "./matches/matchStateRefresh";
import { notifyPopbillFailure } from "./adminNotifications";
import { resolveDataGoKrServiceKey } from "./dataGoKrServiceKey";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";
const ENRICHMENT_CACHE_PROVIDER = "popbill";
const ENRICHMENT_CACHE_SCOPE = "checkBizInfo";
const ENRICHMENT_CACHE_TTL_HOURS_ENV = "CUNOTE_POPBILL_CACHE_TTL_HOURS";
// 국세청(NTS) 상태조회는 무료라 팝빌 캐시 히트 경로에서 하루 1회(KST 달력일) 재확인한다.
// 인증키는 공용 CUNOTE_DATA_GO_KR_SERVICE_KEY 우선, 없으면 이 소스별 변수로 폴백(resolveDataGoKrServiceKey).
const NTS_SERVICE_KEY_ENV = "CUNOTE_NTS_SERVICE_KEY";
const NTS_CACHE_PROVIDER = "nts";
const NTS_CACHE_SCOPE = "status";
// 공공구매종합정보망(SMPP) 여성/장애인 확인서 조회. 팝빌·국세청에 없는 정보라 캐시 히트·라이브 양쪽 경로 모두에 겹친다.
// 확인서는 연 단위 유효하지만 신규 취득을 30일 내에 감지하기 위해 30일 캐시로 둔다.
const SMPP_SERVICE_KEY_ENV = "CUNOTE_SMPP_SERVICE_KEY";
const SMPP_CACHE_PROVIDER = "smpp";
const SMPP_CACHE_SCOPE = "certs";
const SMPP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 팝빌 조회는 사업자당 과금이므로 기본 30일 동안 DB 캐시를 재사용한다.
// 30일이 지나면 다음 조회 시 팝빌을 1회 다시 호출해 최신 상태(휴·폐업/주소 변경 등)로 갱신한다.
// 30일 캐시가 살아있는 동안에도 휴·폐업/과세유형 전환은 무료 국세청(NTS) 상태조회로 매일 감지한다.
// CUNOTE_POPBILL_CACHE_TTL_HOURS로 기간을 조정할 수 있고, 0 이하로 두면 무기한 캐시(재조회 없음)로 동작한다.
const DEFAULT_ENRICHMENT_CACHE_TTL_HOURS = 24 * 30;

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
    if (savedProfile && hasReusableTeaserProfile(savedProfile)) {
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

export async function loadCompanyProfileFromSourceWithEvidence(
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

  const dashboard = buildDashboard({ company, grants, asOf, limit: options.limit ?? 24 });
  // HWPX 보관본이 확보된 공고는 "서식 채움 지원"으로 승격 — /dashboard 와 /api/web/matches 가 함께 탄다.
  dashboard.matches = await annotateMatchCardWriteSupport(dashboard.matches);
  return dashboard;
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

  const sheet = buildApplySheet({
    entry: {
      item: grants,
      match,
    },
    company,
    asOf,
  });
  // core 는 보관본 유무를 모르므로(순수 조립), 여기서 grant_attachment_archives 를 배치 조회해
  // hwpxTemplateAvailable 플래그를 덮어쓴다(HWPX 원본 양식 채움 다운로드 버튼 노출 제어).
  sheet.applicationPrep.draftableDocuments = await annotateHwpxTemplateAvailability({
    grant: { source: sheet.grant.source, sourceId: sheet.grant.sourceId },
    documents: sheet.applicationPrep.draftableDocuments,
  });
  return sheet;
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
  // 팝빌 해석(캐시 히트·라이브 어느 경로든)을 마친 뒤, 공통 후처리로 SMPP 확인서 보강을 겹친다.
  // SMPP 정보는 팝빌에 아예 없으므로 NTS(캐시 히트 한정)와 달리 두 경로 모두 적용한다.
  const base = await resolvePopbillCompanyResolution(input);
  return applySmppCertificates({ bizNo: input.bizNo, now: input.now, resolution: base });
}

async function resolvePopbillCompanyResolution(input: {
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
    const checkedAt = cached?.checkedAt ?? parseProviderCheckedAt(cachedCanonical.facts.checkedAt);
    const cachedUntil = cached?.expiresAt ?? null;
    const rebuildEvidence = (profile: CompanyProfile, summary: string): CompanyEvidence =>
      buildCompanyEvidence({
        provider: "popbill",
        source: "popbill_cache",
        cacheStatus: "hit",
        profile,
        facts: cachedCanonical.facts,
        checkedAt,
        cachedUntil,
        summary,
      });
    const baseResolution: PopbillCompanyResolution = {
      profile: cachedCanonical.profile,
      facts: cachedCanonical.facts,
      evidence: rebuildEvidence(
        cachedCanonical.profile,
        "저장된 팝빌 조회 결과를 재사용해 회사 정보를 바로 확인했습니다.",
      ),
    };
    // 팝빌 캐시 히트 경로에서만 국세청 상태조회로 휴·폐업 전환을 재확인한다(popbill_live 직후는 중복이라 생략).
    return applyNtsBusinessStatusOnCacheHit({
      bizNo: input.bizNo,
      now: input.now,
      resolution: baseResolution,
      rebuildEvidence,
    });
  }

  // 팝빌 라이브 조회(과금) 직전 국세청(NTS) 무료 사전 게이트: 미등록/폐업이면 팝빌 미호출로 차단(과금 0),
  // 휴업이면 통과하되 상태를 라이브 프로필에 병합해 확인 카드에 경고를 노출한다.
  const ntsPreGate = await applyNtsPreGateBeforePopbill({ bizNo: input.bizNo, now: input.now });

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
  // 휴업(02)이면 NTS 상태를 팝빌 라이브 프로필에 병합한다(폐업/미등록은 위에서 이미 throw).
  const liveProfile = ntsPreGate?.classification === "suspended"
    ? applyNtsStatusToProfile(enriched.profile, ntsPreGate.statusData)
    : enriched.profile;
  const facts = toCompanyEnrichmentFacts(enriched.facts);
  const canonicalPayload: Record<string, unknown> = {
    profile: liveProfile,
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

  // 6.5 팝빌 조회 미터링(무과금): 실호출(popbill_live)일 때만 usage_events 에 원가 추적 이벤트를 남긴다.
  //   creditsCharged=0, status=free. bizNoRef 는 pepper HMAC-SHA256 가명 키(무염 SHA-256 금지 — 10자리 역산됨).
  //   랜딩 익명 경로이므로 walletId/userId/companyId 는 null. 캐시 히트는 외부 원가가 없어 기록하지 않는다.
  await recordPopbillLookupMetering(input.bizNo).catch((error) => {
    // 미터링 실패가 팝빌 조회 결과 반환을 막지 않는다(부수효과).
    console.warn(`Popbill lookup metering failed: ${errorMessage(error)}`);
  });

  return {
    profile: liveProfile,
    facts,
    evidence: buildCompanyEvidence({
      provider: "popbill",
      source: "popbill_live",
      cacheStatus,
      profile: liveProfile,
      facts,
      checkedAt: checkedAt ?? input.now,
      cachedUntil,
      summary: cacheStatus === "stored"
        ? "팝빌에서 사업자 정보를 확인했고 다음 조회부터 추가 조회 없이 저장 결과를 재사용합니다."
        : "팝빌에서 사업자 정보를 확인했습니다.",
    }),
  };
}

/**
 * 6.5 팝빌 실호출 미터링. bizNoRef 는 pepper HMAC-SHA256(익명화가 아니라 join 회피용 가명 키).
 * CREDIT_BIZNO_HMAC_PEPPER 미설정 시: 무염 해시로 역산 가능(레드팀 m1)하므로 bizNoRef 를 아예 기록하지 않고
 *   contextRef.pepperMissing=true 로 남긴다(과금은 여전히 0, 이벤트 자체는 기록해 원가 추적은 유지).
 */
async function recordPopbillLookupMetering(bizNo: string): Promise<void> {
  const pepper = process.env.CREDIT_BIZNO_HMAC_PEPPER?.trim();
  const contextRef: Record<string, unknown> = pepper
    ? { bizNoRef: createHmac("sha256", pepper).update(bizNo).digest("hex") }
    : { pepperMissing: true };
  await repositories.creditsSystem.recordFreeUsageEvent({
    walletId: null,
    userId: null,
    companyId: null,
    featureCode: "popbill_lookup",
    provider: "popbill",
    contextRef,
  });
}

function resolvePopbillCacheExpiresAt(now: Date): Date | null {
  const rawTtlHours = process.env[ENRICHMENT_CACHE_TTL_HOURS_ENV]?.trim();
  const ttlHours = rawTtlHours ? Number(rawTtlHours) : DEFAULT_ENRICHMENT_CACHE_TTL_HOURS;
  // 0 이하 또는 유효하지 않은 값이면 무기한 캐시(만료 없음)로 둔다.
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return null;
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

/**
 * 팝빌 캐시 히트 시 국세청(NTS) 상태조회를 하루 1회 겹쳐 휴·폐업 전환을 감지한다.
 * - data.go.kr 인증키(공용/NTS) 미설정: 조용히 skip.
 * - NTS 오류/타임아웃: warn 후 기존(팝빌 캐시) 결과를 그대로 반환(fail-open).
 * - 휴업/폐업(b_stt_cd "02"/"03"): profile.business_status를 NTS 기준으로 갱신. 팝빌 재조회는 하지 않는다.
 */
async function applyNtsBusinessStatusOnCacheHit(input: {
  bizNo: string;
  now: Date;
  resolution: PopbillCompanyResolution;
  rebuildEvidence: (profile: CompanyProfile, summary: string) => CompanyEvidence;
}): Promise<PopbillCompanyResolution> {
  const serviceKey = resolveDataGoKrServiceKey(NTS_SERVICE_KEY_ENV);
  if (!serviceKey) return input.resolution;

  let statusData: NtsBusinessStatusData | null;
  try {
    statusData = await resolveNtsBusinessStatus({ serviceKey, bizNo: input.bizNo, now: input.now });
  } catch (error) {
    console.warn(`국세청 사업자 상태조회 실패(기존 캐시 결과 유지): ${errorMessage(error)}`);
    return input.resolution;
  }
  if (!statusData) return input.resolution;

  const closedLabel = ntsClosedLabel(statusData.b_stt_cd);
  if (!closedLabel) return input.resolution; // 계속사업자(01)이거나 판정 불가(미등록 등) — 그대로 둔다.

  const nextProfile = applyNtsStatusToProfile(input.resolution.profile, statusData);
  const summary = `저장된 팝빌 조회에 국세청 상태조회를 더해 확인했어요. 국세청 기준 현재 ${closedLabel} 상태로 보여요.`;
  return {
    profile: nextProfile,
    facts: input.resolution.facts,
    evidence: input.rebuildEvidence(nextProfile, summary),
  };
}

/**
 * NTS 상태를 하루 1회(KST 달력일) 캐시로 조회한다. 같은 날 재조회는 캐시 히트(API 미호출),
 * 다음날은 만료로 재호출. 캐시 저장 실패는 무과금이라 조회 자체는 허용하되 warn 한다.
 */
async function resolveNtsBusinessStatus(input: {
  serviceKey: string;
  bizNo: string;
  now: Date;
}): Promise<NtsBusinessStatusData | null> {
  let cached: Awaited<ReturnType<typeof repositories.enrichmentCache.getFresh>> = null;
  try {
    cached = await repositories.enrichmentCache.getFresh({
      provider: NTS_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: NTS_CACHE_SCOPE,
      now: input.now,
    });
  } catch (error) {
    // 무과금 API이므로 캐시 조회 실패 시에도 원격 조회로 진행한다(팝빌과 달리 과금 가드 불필요).
    console.warn(`국세청 상태 캐시 조회 실패(원격 조회로 진행): ${errorMessage(error)}`);
  }
  const cachedStatus = parseCachedNtsStatus(cached?.canonicalPayload);
  if (cachedStatus) return cachedStatus;

  const statusData = await checkNtsBusinessStatus({ serviceKey: input.serviceKey, bizNo: input.bizNo });
  const canonicalPayload = statusData as unknown as Record<string, unknown>;
  try {
    await repositories.enrichmentCache.put({
      provider: NTS_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: NTS_CACHE_SCOPE,
      rawPayload: canonicalPayload,
      canonicalPayload,
      providerResultCode: statusData.b_stt_cd || null,
      providerResultMessage: statusData.b_stt || null,
      checkedAt: input.now,
      fetchedAt: input.now,
      expiresAt: nextKstMidnight(input.now),
      payloadHash: hashCanonicalPayload(canonicalPayload),
    });
  } catch (error) {
    console.warn(`국세청 상태 캐시 저장 실패(조회 결과는 사용): ${errorMessage(error)}`);
  }
  return statusData;
}

/**
 * 팝빌 라이브 조회(과금) 직전에 국세청(NTS) 무료 상태조회로 명백한 무효 번호를 걸러낸다.
 * - data.go.kr 인증키(공용/NTS) 미설정: skip(팝빌 진행) — 기존 관례.
 * - NTS 오류/타임아웃: warn 후 fail-open(팝빌 진행).
 * - 미등록: biz_no_not_registered(404)로 팝빌 호출을 차단(과금 0).
 * - 폐업: biz_no_closed(409)로 차단(과금 0). 폐업일이 있으면 문구에 YYYY-MM-DD로 노출.
 * - 휴업: 통과. classification/statusData 를 돌려주어 호출부가 라이브 프로필에 병합하게 한다.
 * 반환: 휴업/계속 등 통과 시 판정 결과, skip/판정 불가 시 null.
 */
async function applyNtsPreGateBeforePopbill(input: {
  bizNo: string;
  now: Date;
}): Promise<{ classification: NtsBusinessStatusClassification; statusData: NtsBusinessStatusData } | null> {
  const serviceKey = resolveDataGoKrServiceKey(NTS_SERVICE_KEY_ENV);
  if (!serviceKey) return null;

  let statusData: NtsBusinessStatusData | null;
  try {
    statusData = await resolveNtsBusinessStatus({ serviceKey, bizNo: input.bizNo, now: input.now });
  } catch (error) {
    // 타임아웃 포함 어떤 실패든 과금을 막지 않고 팝빌로 진행(fail-open).
    console.warn(`국세청 사전 게이트 조회 실패(팝빌 진행): ${errorMessage(error)}`);
    return null;
  }
  if (!statusData) return null;

  const classification = classifyNtsBusinessStatus(statusData);
  if (classification === "not_registered") {
    throw new ServiceDataError(
      "biz_no_not_registered",
      "국세청에 등록되지 않은 사업자등록번호입니다. 번호를 다시 확인해주세요.",
      404,
      "bizNo",
    );
  }
  if (classification === "closed") {
    const closedOn = formatNtsEndDate(statusData.end_dt);
    const message = closedOn
      ? `폐업한 사업자등록번호입니다(폐업일 ${closedOn}).`
      : "폐업한 사업자등록번호입니다.";
    throw new ServiceDataError("biz_no_closed", message, 409, "bizNo");
  }
  return { classification, statusData };
}

/** NTS end_dt(YYYYMMDD)를 YYYY-MM-DD로 포맷한다. 형식이 아니면 null. */
function formatNtsEndDate(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** NTS 휴·폐업 상태를 CompanyProfile.business_status에 반영한 새 프로필을 만든다(순수 함수). */
export function applyNtsStatusToProfile(
  profile: CompanyProfile,
  statusData: NtsBusinessStatusData,
): CompanyProfile {
  const label = ntsClosedLabel(statusData.b_stt_cd);
  return {
    ...profile,
    business_status: {
      ...(profile.business_status ?? {}),
      active: false,
      label: label ?? profile.business_status?.label ?? "휴·폐업",
      close_down_state: statusData.b_stt_cd,
      close_down_tax_type: statusData.tax_type_cd || null,
    },
    confidence: {
      ...(profile.confidence ?? {}),
      business_status: 0.9,
    },
  };
}

/** NTS 상태코드를 라벨로 매핑한다. "02" 휴업, "03" 폐업, 그 외(01/미등록/빈값)는 null. */
export function ntsClosedLabel(code: string | null | undefined): "휴업" | "폐업" | null {
  if (code === "02") return "휴업";
  if (code === "03") return "폐업";
  return null;
}

/** now 시점 기준 Asia/Seoul(UTC+9)의 다음 자정을 UTC Date로 반환한다. */
export function nextKstMidnight(now: Date): Date {
  const shifted = now.getTime() + KST_OFFSET_MS;
  const kstDayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  const nextKstDayStart = kstDayStart + 86_400_000;
  return new Date(nextKstDayStart - KST_OFFSET_MS);
}

function parseCachedNtsStatus(
  payload: Record<string, unknown> | null | undefined,
): NtsBusinessStatusData | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.b_no !== "string" || typeof payload.b_stt_cd !== "string") return null;
  return payload as unknown as NtsBusinessStatusData;
}

/**
 * 공공구매종합정보망(SMPP) 여성/장애인 확인서를 팝빌 해석 결과에 겹친다(캐시 히트·라이브 공통 후처리).
 * - data.go.kr 인증키(공용/SMPP) 미설정: 조용히 skip.
 * - SMPP 오류/타임아웃: warn 후 기존 결과 유지(fail-open).
 * - positive-only: 보유(00)만 프로필에 반영하고, 미보유(90)는 아무것도 바꾸지 않는다.
 */
async function applySmppCertificates(input: {
  bizNo: string;
  now: Date;
  resolution: PopbillCompanyResolution;
}): Promise<PopbillCompanyResolution> {
  const serviceKey = resolveDataGoKrServiceKey(SMPP_SERVICE_KEY_ENV);
  if (!serviceKey) return input.resolution;

  let certs: SmppCertificates | null;
  try {
    certs = await resolveSmppCertificates({ serviceKey, bizNo: input.bizNo, now: input.now });
  } catch (error) {
    console.warn(`공공구매종합정보망 확인서 조회 실패(기존 결과 유지): ${errorMessage(error)}`);
    return input.resolution;
  }
  if (!certs) return input.resolution;

  const { profile, addedLabels } = applySmppCertificatesToProfile(input.resolution.profile, certs);
  // positive-only: 보유 확인서가 하나도 없으면 프로필/근거를 건드리지 않는다.
  if (addedLabels.length === 0) return input.resolution;

  const summary = `공공구매종합정보망에서 ${addedLabels.join(", ")}를 확인했습니다.`;
  return {
    profile,
    facts: input.resolution.facts,
    evidence: appendSmppEvidence(input.resolution.evidence, profile, input.resolution.facts, summary),
  };
}

/**
 * SMPP 확인서를 30일 캐시로 조회한다. 캐시 히트면 API 미호출, 만료되면 재호출.
 * 미보유(both false) 결과도 캐시해 30일간 재조회를 막는다. 캐시 저장 실패는 warn 후 결과는 사용.
 */
async function resolveSmppCertificates(input: {
  serviceKey: string;
  bizNo: string;
  now: Date;
}): Promise<SmppCertificates | null> {
  let cached: Awaited<ReturnType<typeof repositories.enrichmentCache.getFresh>> = null;
  try {
    cached = await repositories.enrichmentCache.getFresh({
      provider: SMPP_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: SMPP_CACHE_SCOPE,
      now: input.now,
    });
  } catch (error) {
    // 무과금 API이므로 캐시 조회 실패 시에도 원격 조회로 진행한다.
    console.warn(`공공구매종합정보망 캐시 조회 실패(원격 조회로 진행): ${errorMessage(error)}`);
  }
  const cachedCerts = parseCachedSmppCertificates(cached?.canonicalPayload);
  if (cachedCerts) return cachedCerts;

  const certs = await checkSmppCertificates({
    serviceKey: input.serviceKey,
    bizNo: input.bizNo,
    stdrDate: kstDateCompact(input.now),
  });
  const canonicalPayload = certs as unknown as Record<string, unknown>;
  try {
    await repositories.enrichmentCache.put({
      provider: SMPP_CACHE_PROVIDER,
      bizNo: input.bizNo,
      scope: SMPP_CACHE_SCOPE,
      rawPayload: canonicalPayload,
      canonicalPayload,
      providerResultCode: smppHeldCode(certs),
      providerResultMessage: null,
      checkedAt: input.now,
      fetchedAt: input.now,
      expiresAt: new Date(input.now.getTime() + SMPP_CACHE_TTL_MS),
      payloadHash: hashCanonicalPayload(canonicalPayload),
    });
  } catch (error) {
    console.warn(`공공구매종합정보망 캐시 저장 실패(조회 결과는 사용): ${errorMessage(error)}`);
  }
  return certs;
}

/**
 * SMPP 확인서 보유(positive)만 CompanyProfile에 반영한 새 프로필을 만든다(순수 함수).
 * - 여성기업 보유 → certs "여성기업확인서"(중복 방지 union), traits "여성기업".
 * - 장애인기업 보유 → certs "장애인기업확인서", traits "장애인기업".
 * - 보유가 하나라도 있으면 confidence.founder_trait = max(기존, 0.9).
 * - certification 축은 절대 known 처리하지 않는다(SMPP는 여성/장애인만 커버 → 벤처·이노비즈 오탈락 방지).
 * addedLabels: 이번에 보유로 확인된 확인서 라벨(요약/근거용).
 */
export function applySmppCertificatesToProfile(
  profile: CompanyProfile,
  certs: SmppCertificates,
): { profile: CompanyProfile; addedLabels: string[] } {
  const certLabels: string[] = [];
  const traitLabels: string[] = [];
  if (certs.women?.held) {
    certLabels.push("여성기업확인서");
    traitLabels.push("여성기업");
  }
  if (certs.disabled?.held) {
    certLabels.push("장애인기업확인서");
    traitLabels.push("장애인기업");
  }
  if (certLabels.length === 0) {
    // positive-only: 미보유는 known으로 마킹하지 않는다(확인서 미신청 기업 존재).
    return { profile, addedLabels: [] };
  }

  return {
    profile: {
      ...profile,
      certs: unionStrings(profile.certs, certLabels),
      traits: unionStrings(profile.traits, traitLabels),
      confidence: {
        ...(profile.confidence ?? {}),
        // founder_trait만 known 처리한다. certification은 의도적으로 설정하지 않는다.
        founder_trait: Math.max(profile.confidence?.founder_trait ?? 0, 0.9),
      },
    },
    addedLabels: certLabels,
  };
}

/** 기존 근거를 보존하되 새 프로필로 fields(보유 인증·확인서 등)를 재계산하고 SMPP 문구를 요약에 덧붙인다. */
function appendSmppEvidence(
  evidence: CompanyEvidence,
  profile: CompanyProfile,
  facts: CompanyEnrichmentFacts | undefined,
  summary: string,
): CompanyEvidence {
  return {
    ...evidence,
    fields: buildCompanyEvidenceFields(profile, facts),
    summary: `${evidence.summary} ${summary}`.trim(),
  };
}

function smppHeldCode(certs: SmppCertificates): string {
  const parts: string[] = [];
  if (certs.women?.held) parts.push("F");
  if (certs.disabled?.held) parts.push("D");
  return parts.length > 0 ? parts.join("") : "none";
}

/** now 시점을 Asia/Seoul(UTC+9) 달력일 YYYYMMDD 문자열로 만든다. */
function kstDateCompact(now: Date): string {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function unionStrings(existing: string[] | undefined, additions: string[]): string[] {
  const result = [...(existing ?? [])];
  for (const value of additions) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function parseCachedSmppCertificates(
  payload: Record<string, unknown> | null | undefined,
): SmppCertificates | null {
  if (!isRecord(payload)) return null;
  if (!("women" in payload) || !("disabled" in payload)) return null;
  return {
    women: parseCachedSmppCertResult(payload.women),
    disabled: parseCachedSmppCertResult(payload.disabled),
  };
}

function parseCachedSmppCertResult(value: unknown): SmppCertificates["women"] {
  if (!isRecord(value)) return null;
  if (typeof value.held !== "boolean") return null;
  return value as unknown as NonNullable<SmppCertificates["women"]>;
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
      available: facts?.hasIndustry ?? Boolean(profile.industries?.length || profile.industry_codes?.length),
      // 라벨만 표시(코드 나열 제거). 라벨이 없으면 KSIC 코드에서 중분류/대분류 명칭으로 보강.
      value: industryEvidenceValue(profile),
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
    // 팝빌로 확인할 수 없는 매칭 핵심 축. 미확보 시 미입력으로 노출해 사용자 입력을 유도한다.
    {
      key: "founder_age",
      label: "대표자 연령",
      available: typeof profile.founder_age === "number",
      value: typeof profile.founder_age === "number" ? `만 ${profile.founder_age}세` : null,
    },
    {
      key: "certification",
      label: "보유 인증·확인서",
      available: Boolean(profile.certs?.length),
      value: profile.certs?.length ? profile.certs.join(", ") : null,
    },
    {
      key: "employees",
      label: "상시근로자",
      available: typeof profile.employees_count === "number",
      value: typeof profile.employees_count === "number"
        ? `${profile.employees_count.toLocaleString("ko-KR")}명`
        : null,
    },
    {
      key: "revenue",
      label: "연 매출",
      available: typeof profile.revenue_krw === "number",
      value: formatRevenueKrw(profile.revenue_krw),
    },
  ];
}

function industryEvidenceValue(profile: CompanyProfile): string | null {
  const labels = (profile.industries ?? []).filter((entry) => !isLikelyKsicCode(entry));
  if (labels.length > 0) return labels.join(", ");
  for (const code of profile.industry_codes ?? []) {
    const derived = ksicDivisionLabel(code) ?? ksicSectionLabel(code);
    if (derived) return derived;
  }
  return null;
}

function formatRevenueKrw(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 100_000_000) {
    const eok = Math.round((value / 100_000_000) * 10) / 10;
    return `${eok.toLocaleString("ko-KR")}억원`;
  }
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
  return `${value.toLocaleString("ko-KR")}원`;
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
  if (enriched.industry_codes?.length) next.industry_codes = enriched.industry_codes;
  if (enriched.size) next.size = enriched.size;
  if (enriched.traits?.length) next.traits = enriched.traits;
  if (enriched.certs?.length) next.certs = enriched.certs;
  if (enriched.prior_awards?.length) next.prior_awards = enriched.prior_awards;
  if (enriched.business_status) next.business_status = enriched.business_status;

  return next;
}

function hasReusableTeaserProfile(profile: CompanyProfile): boolean {
  return Boolean(
    profile.region?.code ||
    profile.region?.label ||
    profile.biz_age_months !== null && profile.biz_age_months !== undefined ||
    profile.industries?.length ||
    profile.industry_codes?.length ||
    profile.size ||
    profile.revenue_krw !== null && profile.revenue_krw !== undefined ||
    profile.employees_count !== null && profile.employees_count !== undefined ||
    profile.business_status?.label ||
    profile.business_status?.active !== undefined
  );
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
    // 구형 캐시(코드가 industries에 섞인 형식)를 읽을 때 새 형식(라벨/코드 분리)으로 재정규화한다.
    profile: normalizeCompanyIndustryProfile(profile as CompanyProfile),
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
