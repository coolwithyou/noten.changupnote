import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApplySheet,
  buildInitialCompanyMatch,
  assembleCompanyProfile,
  companyProfileToFieldUpdates,
  clearProfileQuestionAnswerState,
  checkNtsBusinessStatus,
  checkSmppCertificates,
  classifyNtsBusinessStatus,
  deriveGrantBenefits,
  fetchKStartupPage,
  grantKey,
  maskCorpNum,
  normalizeKStartupPayload,
} from "@cunote/core";
import { resolveEvidencePrecedence } from "@cunote/core/company/evidence-priority";
import {
  buildCompanyProfileFromPopbill,
  isLikelyKsicCode,
  ksicDivisionLabel,
  ksicSectionLabel,
  normalizeCompanyIndustryProfile,
  resolvePopbillTargetType,
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
  CompanyProfileEvidenceObservation,
  CompanyPreviewResult,
  CriterionDimension,
  GrantBenefit,
  NormalizedGrant,
  ProductTeaserResult,
  TeaserRequest,
} from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import type { BizInfoProgram, KStartupAnnouncement, KStartupApiResponse, NtsBusinessStatusClassification, NtsBusinessStatusData, SmppCertificates } from "@cunote/core";
import { createServiceRepositories, getRepositoryAdapterName } from "./repositories/factory";
import { annotateHwpxTemplateAvailability } from "./documents/draftHwpxExport";
import { buildBizInfoSampleEntries } from "./ingestion/bizinfoSample";
import { annotateMatchCardWriteSupport } from "./matches/annotateWriteSupport";
import { refreshMatchStates } from "./matches/matchStateRefresh";
import { notifyPopbillFailure } from "./adminNotifications";
import { getConsentStore } from "./consents/consentStore";
import { resolveDataGoKrServiceKey } from "./dataGoKrServiceKey";
import {
  PublicLookupProtectionError,
  assertPublicLookupClientRate,
  reservePublicLookupBudget,
} from "./publicLookupProtection";
import {
  buildMatchingProfileView,
  ProductProfileResolutionError,
  resolveProductCompanyProfile as resolveProductCompanyProfileWithDependencies,
  type ResolveProductCompanyProfileInput,
  type ResolvedProductCompanyProfile,
} from "./productProfile/resolveProductCompanyProfile";
import { normalizeProductProfileAnswers } from "./productProfile/normalizeProductProfileAnswers";
import {
  buildProductDashboardSnapshot,
  buildProductTeaserSnapshot,
  type ProductDashboardResult,
} from "./productProfile/productMatchSnapshot";

const SAMPLE_PATH = "samples/kstartup_announcement_sample.json";
const ENRICHMENT_CACHE_PROVIDER = "popbill";
const ENRICHMENT_CACHE_SCOPE = "checkBizInfo";
const POPBILL_LOOKUP_GUARD_PROVIDER = "popbill_guard";
const POPBILL_LOOKUP_GUARD_SCOPE = "checkBizInfo-live-attempt";
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
const DEFAULT_ACTIVE_GRANT_SCAN_LIMIT = 5_000;
const DEFAULT_INITIAL_MATCH_LIMIT = 12;

// 동일 사업자번호에 대한 동시 조회를 하나의 팝빌 호출로 합쳐 중복 과금을 막는다(in-flight 요청 dedup).
const inflightPopbillLookups = new Map<string, Promise<PopbillCompanyResolution>>();

type ServiceGrantPayload = KStartupAnnouncement | BizInfoProgram;
type PopbillCredentials = ReturnType<typeof readPopbillEnvConfig>["credentials"];

interface CompanyProfileResolution {
  profile: CompanyProfile;
  evidence: CompanyEvidence | null;
}

interface ProductCompanyPreviewDependencies {
  resolveAnonymous: (
    body: Partial<TeaserRequest>,
    options: { asOf?: Date },
  ) => Promise<ResolvedProductCompanyProfile>;
  acquirePublicBase: (
    bizNo: string,
    options: { asOf?: Date; publicRequestKey?: string },
  ) => Promise<CompanyProfileResolution>;
}

interface PopbillCompanyResolution {
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
  evidence: CompanyEvidence;
}

interface PopbillLookupInput {
  bizNo: string;
  credentials: PopbillCredentials;
  asOf: Date;
  now: Date;
  publicRequestKey?: string;
}

type NtsPreGateResult = {
  classification: NtsBusinessStatusClassification;
  statusData: NtsBusinessStatusData;
} | null;

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

// 활성 공고 유니버스 hydration은 요청당 수천 행을 읽는 가장 비싼 경로라 프로세스 레벨로 짧게 캐시한다.
// asOf는 마감 컷오프 필터에만 쓰이므로 TTL 내 재사용의 영향은 "방금 마감된 공고가 잠시 더 노출"뿐이고,
// D-day 등 asOf 민감 값은 스냅샷 빌더가 매 요청의 asOf로 다시 계산한다.
// promise를 캐시해 동시 요청도 hydration 1회에 합류시키고, 실패 시엔 비워서 다음 요청이 재시도하게 한다.
const GRANT_UNIVERSE_CACHE_TTL_MS = 2 * 60 * 1000;
const grantUniverseCache = new Map<number, {
  asOfMs: number;
  cachedAtMs: number;
  task: Promise<Array<NormalizedGrant<ServiceGrantPayload>>>;
}>();

export function resetGrantUniverseCacheForTests(): void {
  grantUniverseCache.clear();
}

export async function loadServiceGrantUniverse(input: {
  asOf: Date;
  scanLimit?: number;
}): Promise<Array<NormalizedGrant<ServiceGrantPayload>>> {
  const scanLimit = input.scanLimit ?? DEFAULT_ACTIVE_GRANT_SCAN_LIMIT;
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 20_000) {
    throw new Error("scanLimit은 1..20000 정수여야 합니다.");
  }
  // in-memory 어댑터(테스트·목업)는 조회가 싸고, 테스트가 호출 사이에 저장소를 갱신하므로 캐시하지 않는다.
  if (getRepositoryAdapterName() !== "drizzle") {
    return loadServiceGrantUniverseUncached({ asOf: input.asOf, scanLimit });
  }
  const asOfMs = input.asOf.getTime();
  const nowMs = Date.now();
  const cached = grantUniverseCache.get(scanLimit);
  if (
    cached &&
    nowMs - cached.cachedAtMs < GRANT_UNIVERSE_CACHE_TTL_MS &&
    // 과거·미래 시점 조회(asOf가 캐시 시점과 TTL 이상 어긋남)는 필터 결과가 달라질 수 있어 우회한다.
    Math.abs(asOfMs - cached.asOfMs) < GRANT_UNIVERSE_CACHE_TTL_MS
  ) {
    return cached.task;
  }
  const task = loadServiceGrantUniverseUncached({ asOf: input.asOf, scanLimit });
  grantUniverseCache.set(scanLimit, { asOfMs, cachedAtMs: nowMs, task });
  task.catch(() => {
    if (grantUniverseCache.get(scanLimit)?.task === task) {
      grantUniverseCache.delete(scanLimit);
    }
  });
  return task;
}

async function loadServiceGrantUniverseUncached(input: {
  asOf: Date;
  scanLimit: number;
}): Promise<Array<NormalizedGrant<ServiceGrantPayload>>> {
  const grants = await repositories.grants.listActiveGrants({
    asOf: input.asOf,
    // 상한을 넘겼는지 검출하기 위한 sentinel 한 건을 추가한다.
    limit: input.scanLimit + 1,
  });
  if (grants.length > input.scanLimit) {
    throw new ServiceDataError(
      "active_grant_scan_incomplete",
      `활성 공고가 ${input.scanLimit.toLocaleString("ko-KR")}건을 초과해 일부 결과만 반환할 수 없습니다. scanLimit을 높여주세요.`,
      503,
    );
  }
  return grants;
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

async function loadCompanyProfileFromSource(bizNo?: string): Promise<CompanyProfile> {
  return (await loadCompanyProfileFromSourceWithEvidence(bizNo)).profile;
}

export async function loadCompanyProfileFromSourceWithEvidence(
  bizNo?: string,
  options: { asOf?: Date; publicRequestKey?: string } = {},
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
      ...(options.publicRequestKey ? { publicRequestKey: options.publicRequestKey } : {}),
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
  /** 화면에 반환할 상위 공고 수. */
  limit?: number;
  /** 평가할 활성 공고 전체 상한. limit과 분리해 최신 일부만 매칭하는 오류를 막는다. */
  scanLimit?: number;
  asOf?: Date;
  /** system/company-scope 호출에서만 명시적으로 true로 둔다. 사용자 read는 state를 쓰지 않는다. */
  writeMatchStates?: boolean;
} = {}): Promise<ProductDashboardResult> {
  const asOf = options.asOf ?? new Date();
  const resultLimit = options.limit ?? 24;
  const [resolution, grants] = await Promise.all([
    resolveDashboardProductProfile({
      ...(options.companyId ? { companyId: options.companyId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      asOf,
    }),
    loadServiceGrantUniverse({
      asOf,
      ...(options.scanLimit !== undefined ? { scanLimit: options.scanLimit } : {}),
    }),
  ]);
  const company = resolution.profile;
  const dashboard = buildProductDashboardSnapshot({ resolution, grants, asOf, limit: resultLimit });
  // HWPX 보관본이 확보된 공고는 "서식 채움 지원"으로 승격 — /dashboard 와 /api/web/matches 가 함께 탄다.
  dashboard.matches = await annotateMatchCardWriteSupport(dashboard.matches);

  const stateCompanyId = options.companyId ?? company.id;
  if (options.writeMatchStates === true) {
    if (resolution.stateScope !== "company") {
      throw new ServiceDataError(
        "user_scoped_match_state_write_forbidden",
        "사용자별 프로필 결과는 회사 공용 매칭 상태로 저장할 수 없습니다.",
        409,
      );
    }
    // 전체 공고의 판정은 counts/question에 사용하되, 요청마다 수천 행을 쓰지 않도록
    // 실제 응답에 노출한 상위 공고만 match_state로 갱신한다.
    const visibleGrantIds = new Set(dashboard.matches.map((match) => match.grantId));
    await persistMatchStates({
      ...(stateCompanyId ? { companyId: stateCompanyId } : {}),
      company,
      grants: grants.filter((grant) => visibleGrantIds.has(grantKey(grant.grant))),
      asOf,
    });
  }
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
  const [resolution, grants] = await Promise.all([
    resolveDashboardProductProfile({
      ...(options.companyId ? { companyId: options.companyId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      asOf,
    }),
    repositories.grants.findGrantById(grantId, { asOf, limit: options.limit ?? 80 }),
  ]);
  if (!grants) return null;
  const company = resolution.profile;
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
  if (!isValidBizNoChecksum(bizNo)) {
    throw new ServiceDataError(
      "invalid_biz_no",
      "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
      400,
      "bizNo",
    );
  }
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
  const profile = mergeCompanyProfilesForEnrichmentAt(current, resolved.profile, asOf.toISOString());
  await repositories.companies.saveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
    profile,
  });

  const materialized = await resolveProductCompanyProfile({
    context: "owned_read",
    companyId: input.companyId,
    userId: input.userId,
    asOf: asOf.toISOString(),
  });

  const grants = await loadServiceGrantUniverse({ asOf });
  const initialMatch = buildInitialCompanyMatch({
    company: materialized.profile,
    grants,
    asOf,
    limit: DEFAULT_INITIAL_MATCH_LIMIT,
  });
  initialMatch.matches = await annotateMatchCardWriteSupport(initialMatch.matches);

  return {
    profile: materialized.profile,
    profileView: materialized.view,
    facts: resolved.facts,
    evidence: resolved.evidence,
    initialMatch,
  };
}

function loadPopbillCompanyProfile(input: PopbillLookupInput): Promise<PopbillCompanyResolution> {
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

async function fetchPopbillCompanyProfile(input: PopbillLookupInput): Promise<PopbillCompanyResolution> {
  // 팝빌 해석(캐시 히트·라이브 어느 경로든)을 마친 뒤, 공통 후처리로 SMPP 확인서 보강을 겹친다.
  // SMPP 정보는 팝빌에 아예 없으므로 NTS(캐시 히트 한정)와 달리 두 경로 모두 적용한다.
  const base = await resolvePopbillCompanyResolution(input);
  return applySmppCertificates({ bizNo: input.bizNo, now: input.now, resolution: base });
}

async function resolvePopbillCompanyResolution(input: PopbillLookupInput): Promise<PopbillCompanyResolution> {
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
  const cached = await readCachedPopbillResolution(input);
  if (cached) return cached;

  // 신뢰 경계가 아닌 IP 헤더는 로컬 보조 제한에만 쓰지만, 무과금 NTS를 포함한
  // cache-miss 남용이 무제한으로 늘지 않도록 외부 호출 전에 프로세스 로컬 상한을 적용한다.
  if (input.publicRequestKey) {
    try {
      assertPublicLookupClientRate({ clientKey: input.publicRequestKey, now: input.now });
      // 신뢰할 수 없는 IP를 우회하더라도 무과금 NTS와 캐시 DB를 포함한 공개 miss 전체를
      // 신뢰 할당이 불필요한 영속 일일 hard cap으로 먼저 예약한다.
      await reservePublicLookupBudget({
        cache: repositories.enrichmentCache,
        clientKey: input.publicRequestKey,
        reservationKey: input.bizNo,
        now: input.now,
      });
    } catch (error) {
      if (error instanceof PublicLookupProtectionError) {
        throw new ServiceDataError(error.code, error.message, error.status, "bizNo");
      }
      throw error;
    }
  }

  // 무과금 NTS 판정은 영속 Popbill guard 획득 전에 한다. 미등록/폐업으로 provider를
  // 호출하지 않는 요청이 명시적 해제 없는 guard를 남기지 않도록 한다.
  const ntsPreGate = await applyNtsPreGateBeforePopbill({ bizNo: input.bizNo, now: input.now });

  // Supabase transaction pooler에서도 안전하도록 session lock 대신 PK upsert 조건을 쓴다.
  // 행이 없거나 만료된 경우에만 단일 SQL로 lease를 획득하므로 여러 Node 인스턴스가
  // 동시에 miss를 보더라도 유료 호출은 하나만 시작한다.
  const claimed = await claimPopbillLiveLookup(input);
  if (!claimed) {
    // 다른 인스턴스가 첫 cache read 직후 저장을 끝낸 경합이면 그 결과를 즉시 재사용한다.
    const raced = await readCachedPopbillResolution(input);
    if (raced) {
      await settlePopbillLiveLookupGuard({
        bizNo: input.bizNo,
        now: input.now,
        expiresAt: parseProviderCheckedAt(raced.evidence.cachedUntil),
        state: "cache_race_resolved",
      }).catch((error) => {
        console.warn(`Popbill 조회 guard 정산 실패(종료 경합): ${errorMessage(error)}`);
      });
      return raced;
    }
    throw new ServiceDataError(
      "popbill_lookup_busy",
      "같은 사업자정보 조회가 진행 중입니다. 잠시 후 다시 확인해주세요.",
      503,
      "bizNo",
    );
  }

  // lease 획득 직전에 다른 요청이 실제 캐시를 저장했을 수 있으므로 과금 직전 한 번 더 확인한다.
  let rechecked: PopbillCompanyResolution | null;
  try {
    rechecked = await readCachedPopbillResolution(input);
  } catch (error) {
    // provider 호출 전 캐시 재확인에서 끝난 요청이므로 이 요청의 guard는 해제할 수 있다.
    await releasePopbillLiveLookupGuard(input.bizNo).catch((releaseError) => {
      console.warn(`Popbill 조회 guard 해제 실패(캐시 재확인): ${errorMessage(releaseError)}`);
    });
    throw error;
  }
  if (rechecked) {
    await settlePopbillLiveLookupGuard({
      bizNo: input.bizNo,
      now: input.now,
      expiresAt: parseProviderCheckedAt(rechecked.evidence.cachedUntil),
      state: "cache_race_resolved",
    }).catch((error) => {
      console.warn(`Popbill 조회 guard 정산 실패(캐시 경합): ${errorMessage(error)}`);
    });
    return rechecked;
  }
  return runLivePopbillLookup(input, ntsPreGate);
}

async function readCachedPopbillResolution(
  input: PopbillLookupInput,
): Promise<PopbillCompanyResolution | null> {
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
  if (!cachedCanonical) return null;

  const checkedAt = cached?.checkedAt ?? parseProviderCheckedAt(cachedCanonical.facts.checkedAt);
  const cachedUntil = cached?.expiresAt ?? null;
  const cachedProfile = backfillCachedPopbillTargetType(
    cachedCanonical.profile,
    cached?.rawPayload,
    checkedAt,
  );
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
    profile: cachedProfile,
    facts: cachedCanonical.facts,
    evidence: rebuildEvidence(
      cachedProfile,
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

async function claimPopbillLiveLookup(input: PopbillLookupInput): Promise<boolean> {
  try {
    const canonicalPayload = {
      state: "attempt_reserved",
      reservedAt: input.now.toISOString(),
    };
    const claimed = await repositories.enrichmentCache.claim({
      provider: POPBILL_LOOKUP_GUARD_PROVIDER,
      bizNo: input.bizNo,
      scope: POPBILL_LOOKUP_GUARD_SCOPE,
      rawPayload: null,
      canonicalPayload,
      providerResultCode: "reserved",
      providerResultMessage: "Popbill live lookup reservation",
      checkedAt: input.now,
      fetchedAt: input.now,
      now: input.now,
      // SDK hang/서버 종료 시에도 다른 인스턴스가 재과금하지 않도록 명시적 정산 전까지 영속 guard로 둔다.
      expiresAt: null,
      payloadHash: hashCanonicalPayload(canonicalPayload),
    });
    return claimed !== null;
  } catch (error) {
    console.warn(`Popbill 조회 차단: 라이브 조회 예약 실패 - ${errorMessage(error)}`);
    throw new ServiceDataError(
      "popbill_cache_unavailable",
      "사업자 정보 중복조회 방지 상태를 저장하지 못해 조회를 진행할 수 없습니다. 잠시 후 다시 시도해주세요.",
      503,
      "bizNo",
    );
  }
}

async function runLivePopbillLookup(
  input: PopbillLookupInput,
  ntsPreGate: NtsPreGateResult,
): Promise<PopbillCompanyResolution> {
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
    ? applyNtsStatusToProfile(enriched.profile, ntsPreGate.statusData, input.now.toISOString())
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
  let cacheStored = false;

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
    cacheStored = true;
  } catch (error) {
    cacheStatus = "none";
    cachedUntil = null;
    console.warn(`Company enrichment cache write failed: ${errorMessage(error)}`);
  }

  if (cacheStored) {
    await settlePopbillLiveLookupGuard({
      bizNo: input.bizNo,
      now: input.now,
      expiresAt,
      state: "cache_stored",
    }).catch((error) => {
      // 실제 캐시가 이미 영속 저장됐으므로 결과를 버리지 않는다. 영속 guard는 후속 재조회를 보수적으로 차단한다.
      console.warn(`Popbill 조회 guard 정산 실패(캐시 저장 후): ${errorMessage(error)}`);
    });
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

async function settlePopbillLiveLookupGuard(input: {
  bizNo: string;
  now: Date;
  expiresAt: Date | null;
  state: "cache_stored" | "cache_race_resolved";
}): Promise<void> {
  const canonicalPayload = { state: input.state, settledAt: input.now.toISOString() };
  await repositories.enrichmentCache.put({
    provider: POPBILL_LOOKUP_GUARD_PROVIDER,
    bizNo: input.bizNo,
    scope: POPBILL_LOOKUP_GUARD_SCOPE,
    canonicalPayload,
    providerResultCode: "settled",
    providerResultMessage: "Popbill live lookup guard settled against durable cache",
    checkedAt: input.now,
    fetchedAt: input.now,
    expiresAt: input.expiresAt,
    payloadHash: hashCanonicalPayload(canonicalPayload),
  });
}

async function releasePopbillLiveLookupGuard(bizNo: string): Promise<void> {
  await repositories.enrichmentCache.deleteByBizNo({
    bizNo,
    provider: POPBILL_LOOKUP_GUARD_PROVIDER,
    scope: POPBILL_LOOKUP_GUARD_SCOPE,
  });
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

  const nextProfile = applyNtsStatusToProfile(input.resolution.profile, statusData, input.now.toISOString());
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
}): Promise<NtsPreGateResult> {
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
  asOf: string | null = null,
): CompanyProfile {
  const label = ntsClosedLabel(statusData.b_stt_cd);
  const next: CompanyProfile = {
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
  return withProfileFieldEvidence(next, "business_status", {
    sourceKind: "authoritative_api",
    provider: "nts",
    asOf,
    axisCompleteness: "complete",
    confidence: 0.9,
  }, "replace");
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

  const { profile, addedLabels } = applySmppCertificatesToProfile(
    input.resolution.profile,
    certs,
    input.now.toISOString(),
  );
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
  asOf: string | null = null,
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

  let next: CompanyProfile = {
    ...profile,
    certs: unionStrings(profile.certs, certLabels),
    traits: unionStrings(profile.traits, traitLabels),
    confidence: {
      ...(profile.confidence ?? {}),
      // founder_trait만 known 처리한다. certification은 의도적으로 설정하지 않는다.
      founder_trait: Math.max(profile.confidence?.founder_trait ?? 0, 0.9),
    },
  };
  next.list_completeness = {
    ...(profile.list_completeness ?? {}),
    founder_trait: "partial",
    certification: "partial",
  };
  next = withProfileFieldEvidence(next, "founder_trait", {
    sourceKind: "authoritative_api",
    provider: "smpp",
    asOf,
    axisCompleteness: "partial",
    confidence: 0.9,
  }, "supplemental");
  next = withProfileFieldEvidence(next, "certification", {
    sourceKind: "authoritative_api",
    provider: "smpp",
    asOf,
    axisCompleteness: "partial",
    confidence: null,
  }, "supplemental");
  return { profile: next, addedLabels: certLabels };
}

function withProfileFieldEvidence(
  profile: CompanyProfile,
  dimension: CriterionDimension,
  observation: CompanyProfileEvidenceObservation,
  mode: "replace" | "supplemental",
): CompanyProfile {
  const existing = profile.profile_evidence?.[dimension];
  const evidence = mode === "supplemental" && existing
    ? {
      ...existing,
      supplemental: appendUniqueObservation(existing.supplemental, observation),
    }
    : observation;
  return {
    ...profile,
    profile_evidence: {
      ...(profile.profile_evidence ?? {}),
      [dimension]: evidence,
    },
  };
}

function appendUniqueObservation(
  existing: CompanyProfileEvidenceObservation[] | undefined,
  incoming: CompanyProfileEvidenceObservation,
): CompanyProfileEvidenceObservation[] {
  const values = [...(existing ?? [])];
  if (!values.some((item) =>
    item.sourceKind === incoming.sourceKind &&
    item.provider === incoming.provider &&
    item.asOf === incoming.asOf &&
    item.axisCompleteness === incoming.axisCompleteness &&
    item.confidence === incoming.confidence)) {
    values.push(incoming);
  }
  return values;
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

export async function resolveProductCompanyProfile(
  input: ResolveProductCompanyProfileInput,
): Promise<ResolvedProductCompanyProfile> {
  return resolveProductCompanyProfileWithDependencies(input, {
    companies: repositories.companies,
    enrichmentCache: repositories.enrichmentCache,
    consents: getConsentStore(),
    refreshOwnedSource: async (refresh) => {
      await loadEnvInDevelopment();
      const popbill = readPopbillEnvConfig();
      const at = new Date(refresh.asOf);
      const resolved = await loadPopbillCompanyProfile({
        bizNo: refresh.bizNo,
        credentials: popbill.credentials,
        asOf: at,
        now: at,
      });
      return resolved.profile;
    },
  });
}

export async function loadProductTeaser(
  body: Partial<TeaserRequest>,
  options: { asOf?: Date } = {},
): Promise<ProductTeaserResult> {
  const asOf = options.asOf ?? new Date();
  const [resolution, grants] = await Promise.all([
    resolveAnonymousProductCompanyProfile(body, { asOf }),
    loadServiceGrantUniverse({ asOf }),
  ]);
  const result = buildProductTeaserSnapshot({ resolution, grants, asOf });
  result.matches = await annotateMatchCardWriteSupport(result.matches);
  result.recommendableMatches = result.matches.filter((match) =>
    recommendationTierForMatch(match) === "recommendable" && match.status === "open");
  result.reviewNeededMatches = result.matches.filter((match) => {
    const tier = recommendationTierForMatch(match);
    return tier === "needs_core_review" || tier === "needs_profile_input";
  });
  return result;
}

export async function resolveAnonymousProductCompanyProfile(
  body: Partial<TeaserRequest>,
  options: { asOf?: Date } = {},
): Promise<ResolvedProductCompanyProfile> {
  const asOf = options.asOf ?? new Date();
  const asOfIso = asOf.toISOString();
  const normalizedRequestProfile = body.profile !== undefined || body.answers !== undefined
    ? normalizeProductProfileAnswers({
      asOf: asOfIso,
      ...(body.answers !== undefined ? { answers: body.answers } : {}),
      ...(body.profile !== undefined ? { legacyProfile: body.profile } : {}),
    })
    : undefined;
  const ephemeralProfile = normalizedRequestProfile && Object.keys(normalizedRequestProfile).length > 0
    ? normalizedRequestProfile
    : undefined;
  return resolveProductCompanyProfile({
    context: "anonymous_teaser",
    ...(body.bizNo ? { bizNo: body.bizNo } : {}),
    ...(ephemeralProfile ? { ephemeralProfile } : {}),
    asOf: asOfIso,
  });
}

export async function loadProductCompanyPreview(
  bizNoInput: string,
  options: {
    asOf?: Date;
    publicRequestKey?: string;
    dependencies?: ProductCompanyPreviewDependencies;
  } = {},
): Promise<CompanyPreviewResult> {
  const bizNo = bizNoInput.trim();
  if (!bizNo || !isValidBizNoChecksum(bizNo)) {
    throw new ServiceDataError(
      "invalid_biz_no",
      "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
      400,
      "bizNo",
    );
  }

  const asOf = options.asOf ?? new Date();
  const dependencies = options.dependencies ?? {
    resolveAnonymous: resolveAnonymousProductCompanyProfile,
    acquirePublicBase: loadCompanyProfileFromSourceWithEvidence,
  };
  let acquisitionEvidence: CompanyEvidence | null = null;
  let resolution: ResolvedProductCompanyProfile;
  try {
    resolution = await dependencies.resolveAnonymous({ bizNo }, { asOf });
  } catch (error) {
    if (!(error instanceof ProductProfileResolutionError) || error.code !== "product_profile_unavailable") {
      throw error;
    }

    // company-preview POST는 사용자가 명시적으로 요청한 공개 기본조회 command다.
    // passive teaser는 계속 cache-only이고, 이 경로만 기존 DB guard/NTS pre-gate/single-flight를 거쳐
    // cache miss 시 Popbill을 최대 한 번 호출한 뒤 resolver가 방금 저장된 public cache를 다시 읽는다.
    const acquired = await dependencies.acquirePublicBase(bizNo, {
      asOf,
      ...(options.publicRequestKey ? { publicRequestKey: options.publicRequestKey } : {}),
    });
    acquisitionEvidence = acquired.evidence;
    if (acquisitionEvidence?.cacheStatus === "none") {
      // 이미 과금된 성공 결과를 버리면 사용자 재시도를 유발한다. 현재 preview는
      // 획득한 공개 최소 필드로 성공 반환하고, 영속 guard가 후속 동일 번호 재과금을 차단한다.
      return buildCompanyPreviewResult({
        bizNo,
        profile: acquired.profile,
        checkedAt: acquisitionEvidence.checkedAt,
        cacheStatus: "none",
      });
    }
    resolution = await dependencies.resolveAnonymous({ bizNo }, { asOf });
  }
  const profile = resolution.profile;
  const checkedAt = resolution.view.rows
    .flatMap((row) => row.asOf ? [row.asOf] : [])
    .sort()
    .at(-1);
  return buildCompanyPreviewResult({
    bizNo,
    profile,
    ...(checkedAt ? { checkedAt } : {}),
    ...(resolution.sourceReceipts.some((receipt) => receipt.state === "consumed")
      ? { cacheStatus: acquisitionEvidence?.cacheStatus ?? "hit" }
      : {}),
  });
}

function buildCompanyPreviewResult(input: {
  bizNo: string;
  profile: CompanyProfile;
  checkedAt?: string | null;
  cacheStatus?: string;
}): CompanyPreviewResult {
  const profile = input.profile;
  const businessStatus: NonNullable<CompanyPreviewResult["businessStatus"]> = {};
  if (typeof profile.business_status?.active === "boolean") {
    businessStatus.active = profile.business_status.active;
  }
  if (profile.business_status?.label) {
    businessStatus.label = profile.business_status.label;
  }

  const result: CompanyPreviewResult = {
    name: profile.name ?? null,
    maskedBizNo: maskCorpNum(input.bizNo),
  };
  if (Object.keys(businessStatus).length > 0) result.businessStatus = businessStatus;
  const regionLabel = profile.region?.label ?? profile.region?.code;
  if (regionLabel) result.regionLabel = regionLabel;
  if (input.checkedAt) result.checkedAt = input.checkedAt;
  if (input.cacheStatus) result.cacheStatus = input.cacheStatus;
  return result;
}

export async function loadProductDashboard(input: {
  companyId: string;
  userId: string;
  asOf?: Date;
  limit?: number;
}): Promise<ProductDashboardResult> {
  return loadServiceDashboard({
    companyId: input.companyId,
    userId: input.userId,
    ...(input.asOf ? { asOf: input.asOf } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    writeMatchStates: false,
  });
}

function recommendationTierForMatch(
  match: ProductTeaserResult["matches"][number],
): NonNullable<ProductTeaserResult["matches"][number]["recommendationTier"]> {
  return match.recommendationTier ??
    (match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input");
}

async function resolveDashboardProductProfile(input: {
  companyId?: string;
  userId?: string;
  asOf: Date;
}): Promise<Pick<ResolvedProductCompanyProfile, "profile" | "view" | "stateScope">> {
  if (!input.companyId) {
    // Sample/dev verification is the sole compatibility boundary without a persisted company id.
    const profile = await repositories.companies.getDefaultCompanyProfile();
    return {
      profile,
      view: buildMatchingProfileView(profile, input.asOf.toISOString()),
      stateScope: "company",
    };
  }
  return resolveProductCompanyProfile(input.userId
    ? {
      context: "owned_read",
      companyId: input.companyId,
      userId: input.userId,
      asOf: input.asOf.toISOString(),
    }
    : {
      context: "system_recompute",
      companyId: input.companyId,
      asOf: input.asOf.toISOString(),
    });
}

async function persistMatchStates(input: {
  companyId?: string;
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
    {
      key: "target_type",
      label: "사업자 유형",
      available: Boolean(profile.target_types?.length),
      value: profile.target_types?.length ? profile.target_types.join(", ") : null,
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

/** 이전 버전 캐시의 raw personCorpCode를 안전하게 재투영한다. 기존 canonical 값은 덮지 않는다. */
export function backfillCachedPopbillTargetType(
  profile: CompanyProfile,
  rawPayload: Record<string, unknown> | null | undefined,
  checkedAt: Date | null,
): CompanyProfile {
  if (profile.target_types?.length || !rawPayload) return profile;
  const targetType = resolvePopbillTargetType(
    rawPayload.personCorpCode as string | number | null | undefined,
  );
  if (!targetType) return profile;
  const asOf = checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toISOString() : null;
  return {
    ...profile,
    target_types: [targetType],
    list_completeness: { ...(profile.list_completeness ?? {}), target_type: "partial" },
    confidence: { ...(profile.confidence ?? {}), target_type: 1 },
    profile_evidence: {
      ...(profile.profile_evidence ?? {}),
      target_type: {
        sourceKind: "authoritative_api",
        provider: "popbill",
        asOf,
        axisCompleteness: "partial",
        confidence: 1,
      },
    },
  };
}

/** P1 compatibility wrapper for callers that do not yet carry request asOf. */
export function mergeCompanyProfilesForEnrichment(current: CompanyProfile, enriched: CompanyProfile): CompanyProfile {
  return mergeCompanyProfilesForEnrichmentAt(current, enriched, profileMergeAsOf(enriched));
}

export function mergeCompanyProfilesForEnrichmentAt(
  current: CompanyProfile,
  enriched: CompanyProfile,
  asOf: string,
): CompanyProfile {
  const legacy = legacyMergeCompanyProfilesForEnrichment(current, enriched);
  const updates = companyProfileToFieldUpdates(enriched);
  if (updates.length === 0) return legacy;
  const assembled = assembleCompanyProfile({ baseProfile: current, updates, asOf }).profile;
  let result = legacy;
  for (const field of new Set(updates.map((update) => update.field))) {
    result = copyAssembledDimension(result, assembled, field);
  }
  return result;
}

/** Frozen P0 behavior used only by the P1 old/new parity fixture. */
export function legacyMergeCompanyProfilesForEnrichment(
  current: CompanyProfile,
  enriched: CompanyProfile,
): CompanyProfile {
  const mergedEvidence = mergeProfileEvidence(current.profile_evidence, enriched.profile_evidence);
  const next: CompanyProfile = {
    ...current,
    confidence: {
      ...(current.confidence ?? {}),
    },
    ...(mergedEvidence && Object.keys(mergedEvidence).length > 0 ? { profile_evidence: mergedEvidence } : {}),
    ...(current.list_completeness && Object.keys(current.list_completeness).length > 0
      ? { list_completeness: { ...current.list_completeness } }
      : {}),
  };

  if (enriched.name) next.name = enriched.name;
  if (enriched.region && shouldApplyEnrichedDimension(current, enriched, "region")) next.region = enriched.region;
  if (
    enriched.biz_age_months !== null &&
    enriched.biz_age_months !== undefined &&
    shouldApplyEnrichedDimension(current, enriched, "biz_age")
  ) {
    next.biz_age_months = enriched.biz_age_months;
  }
  if (
    enriched.founder_age !== null &&
    enriched.founder_age !== undefined &&
    shouldApplyEnrichedDimension(current, enriched, "founder_age")
  ) {
    next.founder_age = enriched.founder_age;
  }
  if (enriched.is_preliminary !== undefined) next.is_preliminary = enriched.is_preliminary;
  const industries = mergeProfileList(current, enriched, "industry", current.industries, enriched.industries);
  const industryCodes = mergeProfileList(current, enriched, "industry", current.industry_codes, enriched.industry_codes);
  if (industries?.length) next.industries = industries;
  if (industryCodes?.length) next.industry_codes = industryCodes;
  if (enriched.size && shouldApplyEnrichedDimension(current, enriched, "size")) next.size = enriched.size;
  const traits = mergeProfileList(current, enriched, "founder_trait", current.traits, enriched.traits);
  const certs = mergeProfileList(current, enriched, "certification", current.certs, enriched.certs);
  const priorAwards = mergeProfileList(current, enriched, "prior_award", current.prior_awards, enriched.prior_awards);
  const ip = mergeProfileList(current, enriched, "ip", current.ip, enriched.ip);
  const targetTypes = mergeProfileList(current, enriched, "target_type", current.target_types, enriched.target_types);
  if (traits?.length) next.traits = traits;
  if (certs?.length) next.certs = certs;
  if (priorAwards?.length) next.prior_awards = priorAwards;
  if (ip?.length) next.ip = ip;
  if (targetTypes?.length) next.target_types = targetTypes;
  for (const [rawDimension, completeness] of Object.entries(enriched.list_completeness ?? {})) {
    const dimension = rawDimension as CriterionDimension;
    if (shouldApplyEnrichedDimension(current, enriched, dimension)) {
      next.list_completeness = { ...(next.list_completeness ?? {}), [dimension]: completeness };
    }
  }
  if (
    enriched.revenue_krw !== null &&
    enriched.revenue_krw !== undefined &&
    shouldApplyEnrichedDimension(current, enriched, "revenue")
  ) next.revenue_krw = enriched.revenue_krw;
  if (
    enriched.employees_count !== null &&
    enriched.employees_count !== undefined &&
    shouldApplyEnrichedDimension(current, enriched, "employees")
  ) next.employees_count = enriched.employees_count;
  if (enriched.business_status && shouldApplyEnrichedDimension(current, enriched, "business_status")) {
    next.business_status = { ...(current.business_status ?? {}), ...enriched.business_status };
  }
  if (enriched.tax_compliance && shouldApplyEnrichedDimension(current, enriched, "tax_compliance")) {
    next.tax_compliance = enriched.tax_compliance;
  }
  if (enriched.credit_status && shouldApplyEnrichedDimension(current, enriched, "credit_status")) {
    next.credit_status = enriched.credit_status;
  }
  if (enriched.sanction && shouldApplyEnrichedDimension(current, enriched, "sanction")) {
    next.sanction = enriched.sanction;
  }
  if (enriched.financial_health && shouldApplyEnrichedDimension(current, enriched, "financial_health")) {
    next.financial_health = { ...(current.financial_health ?? {}), ...enriched.financial_health };
  }
  if (enriched.insured_workforce && shouldApplyEnrichedDimension(current, enriched, "insured_workforce")) {
    next.insured_workforce = { ...(current.insured_workforce ?? {}), ...enriched.insured_workforce };
  }
  if (enriched.investment && shouldApplyEnrichedDimension(current, enriched, "investment")) {
    next.investment = { ...(current.investment ?? {}), ...enriched.investment };
  }
  if (enriched.other_conditions) {
    next.other_conditions = { ...(current.other_conditions ?? {}), ...enriched.other_conditions };
  }
  if (enriched.question_answer_state) {
    next.question_answer_state = {
      ...(current.question_answer_state ?? {}),
      ...enriched.question_answer_state,
    };
  }

  for (const [rawDimension, confidence] of Object.entries(enriched.confidence ?? {})) {
    const dimension = rawDimension as CriterionDimension;
    if (typeof confidence === "number" && shouldApplyEnrichedDimension(current, enriched, dimension)) {
      next.confidence = { ...(next.confidence ?? {}), [dimension]: confidence };
    }
  }

  if (next.industries?.length === 0) delete next.industries;
  if (next.industry_codes?.length === 0) delete next.industry_codes;
  if (next.traits?.length === 0) delete next.traits;
  if (next.certs?.length === 0) delete next.certs;
  if (next.prior_awards?.length === 0) delete next.prior_awards;
  if (next.ip?.length === 0) delete next.ip;
  if (next.target_types?.length === 0) delete next.target_types;
  if (next.profile_evidence && Object.keys(next.profile_evidence).length === 0) delete next.profile_evidence;
  if (next.list_completeness && Object.keys(next.list_completeness).length === 0) delete next.list_completeness;

  let result = next;
  for (const rawDimension of Object.keys(enriched.profile_evidence ?? {})) {
    const dimension = rawDimension as CriterionDimension;
    if (shouldApplyEnrichedDimension(current, enriched, dimension)) {
      result = clearProfileQuestionAnswerState(result, dimension);
    }
  }
  return result;
}

function profileMergeAsOf(profile: CompanyProfile): string {
  const timestamps = Object.values(profile.profile_evidence ?? {})
    .flatMap((evidence) => evidence?.asOf ? [evidence.asOf] : [])
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort();
  return timestamps.at(-1) ?? "1970-01-01T00:00:00.000Z";
}

function copyAssembledDimension(
  target: CompanyProfile,
  assembled: CompanyProfile,
  field: CriterionDimension,
): CompanyProfile {
  const next: CompanyProfile = { ...target };
  const copy = <K extends keyof CompanyProfile>(key: K) => {
    if (assembled[key] === undefined) delete next[key];
    else next[key] = assembled[key];
  };
  switch (field) {
    case "region": copy("region"); break;
    case "biz_age": copy("biz_age_months"); break;
    case "industry": copy("industries"); copy("industry_codes"); break;
    case "size": copy("size"); break;
    case "revenue": copy("revenue_krw"); break;
    case "employees": copy("employees_count"); break;
    case "founder_age": copy("founder_age"); break;
    case "founder_trait": copy("traits"); break;
    case "certification": copy("certs"); break;
    case "prior_award": copy("prior_awards"); copy("prior_award_history"); break;
    case "ip": copy("ip"); break;
    case "target_type": copy("target_types"); break;
    case "business_status": copy("business_status"); break;
    case "tax_compliance": copy("tax_compliance"); break;
    case "credit_status": copy("credit_status"); break;
    case "sanction": copy("sanction"); break;
    case "financial_health": copy("financial_health"); break;
    case "insured_workforce": copy("insured_workforce"); break;
    case "investment": copy("investment"); break;
    case "other": copy("other_conditions"); break;
    case "premises":
    case "export_performance": break;
  }
  const confidence = copyDimensionEntry(target.confidence, assembled.confidence, field);
  const profileEvidence = copyDimensionEntry(target.profile_evidence, assembled.profile_evidence, field);
  const questionState = copyDimensionEntry(
    target.question_answer_state,
    assembled.question_answer_state,
    field,
  );
  if (confidence && Object.keys(confidence).length > 0) next.confidence = confidence;
  else delete next.confidence;
  if (profileEvidence && Object.keys(profileEvidence).length > 0) next.profile_evidence = profileEvidence;
  else delete next.profile_evidence;
  if (questionState && Object.keys(questionState).length > 0) next.question_answer_state = questionState;
  else delete next.question_answer_state;
  if (isProfileListDimension(field)) {
    const completeness = copyDimensionEntry(target.list_completeness, assembled.list_completeness, field);
    if (completeness && Object.keys(completeness).length > 0) next.list_completeness = completeness;
    else delete next.list_completeness;
  }
  return next;
}

function copyDimensionEntry<T extends Partial<Record<CriterionDimension, unknown>>>(
  target: T | undefined,
  source: T | undefined,
  field: CriterionDimension,
): T | undefined {
  const next = { ...(target ?? {}) } as T;
  if (source?.[field] === undefined) delete next[field];
  else next[field] = source[field];
  return next;
}

function isProfileListDimension(field: CriterionDimension): boolean {
  return field === "industry" || field === "founder_trait" || field === "certification" ||
    field === "prior_award" || field === "ip" || field === "target_type";
}

function mergeProfileList(
  currentProfile: CompanyProfile,
  enrichedProfile: CompanyProfile,
  dimension: CriterionDimension,
  current: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!incoming?.length) return current;
  if (!current?.length) return incoming;
  const incomingEvidence = enrichedProfile.profile_evidence?.[dimension];
  const incomingPrimary = shouldApplyEnrichedDimension(currentProfile, enrichedProfile, dimension);
  if (!incomingPrimary) return current;
  if (!incomingEvidence || incomingEvidence.axisCompleteness === "complete") return incoming;
  return unionStrings(current, incoming);
}

function shouldApplyEnrichedDimension(
  current: CompanyProfile,
  enriched: CompanyProfile,
  dimension: CriterionDimension,
): boolean {
  const incoming = enriched.profile_evidence?.[dimension];
  const existing = current.profile_evidence?.[dimension];
  if (!incoming || !existing) return true;
  return resolveEvidencePrecedence({ dimension, current: existing, incoming }).decision === "replace";
}

function mergeProfileEvidence(
  current: CompanyProfile["profile_evidence"],
  incoming: CompanyProfile["profile_evidence"],
): CompanyProfile["profile_evidence"] {
  const merged = { ...(current ?? {}) };
  for (const [rawDimension, incomingEvidence] of Object.entries(incoming ?? {})) {
    if (!incomingEvidence) continue;
    const dimension = rawDimension as CriterionDimension;
    const currentEvidence = merged[dimension];
    if (!currentEvidence) {
      merged[dimension] = incomingEvidence;
      continue;
    }
    const incomingPrimary = resolveEvidencePrecedence({
      dimension,
      current: currentEvidence,
      incoming: incomingEvidence,
    }).decision === "replace";
    const primary = incomingPrimary ? incomingEvidence : currentEvidence;
    const secondary = incomingPrimary ? currentEvidence : incomingEvidence;
    const supplemental = [
      ...(primary.supplemental ?? []),
      stripSupplemental(secondary),
      ...(secondary.supplemental ?? []),
    ].reduce<CompanyProfileEvidenceObservation[]>(appendObservationReducer, []);
    merged[dimension] = supplemental.length > 0 ? { ...primary, supplemental } : primary;
  }
  return merged;
}

function stripSupplemental(evidence: CompanyProfileEvidenceObservation): CompanyProfileEvidenceObservation {
  return {
    sourceKind: evidence.sourceKind,
    provider: evidence.provider,
    asOf: evidence.asOf,
    axisCompleteness: evidence.axisCompleteness,
    confidence: evidence.confidence,
  };
}

function appendObservationReducer(
  values: CompanyProfileEvidenceObservation[],
  incoming: CompanyProfileEvidenceObservation,
): CompanyProfileEvidenceObservation[] {
  if (!values.some((item) =>
    item.sourceKind === incoming.sourceKind &&
    item.provider === incoming.provider &&
    item.asOf === incoming.asOf &&
    item.axisCompleteness === incoming.axisCompleteness &&
    item.confidence === incoming.confidence)) values.push(incoming);
  return values;
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
