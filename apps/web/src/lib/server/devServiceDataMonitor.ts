import { maskCorpNum } from "@cunote/core";
import {
  buildCompanyProfileFromCodef,
  checkFscCorpFinance,
  checkFscPersonalFinance,
  checkKcomwelEmployment,
  checkNiceCorpCredit,
  checkNiceCorpIndicator,
  DISQUALIFICATION_EXCEPTION_LABELS,
  DISQUALIFICATION_EXCEPTIONS,
  DISQUALIFICATION_FLAG_LABELS,
  DISQUALIFICATION_QUESTIONS,
} from "@cunote/core";
import type {
  CorporateRegistrationFacts,
  DisqualificationAxis,
  DisqualificationFlag,
  EnrichmentCacheEntry,
  NtsBusinessStatusData,
  SmppCertificates,
  VatBaseFacts,
} from "@cunote/core";
import { sanitizeCorpNum } from "@cunote/core/popbill/check-biz-info";
import type { CompanyEvidence, CompanyProfile, CriterionDimension } from "@cunote/contracts";
import {
  APICK_BIZ_DETAIL,
  APICK_BIZ_DETAIL_GUARD,
  loadApickBizDetailCompanyProfile,
} from "./apickBizDetail";
import { resolveDataGoKrServiceKey } from "./dataGoKrServiceKey";
import {
  applySmppCertificatesToProfile,
  getServiceRepositories,
  loadCompanyProfileFromSourceWithEvidence,
  ntsClosedLabel,
  ServiceDataError,
} from "./serviceData";

// ─────────────────────────────────────────────────────────────────────────────
// 개발 전용 사업자 데이터 모니터. 실제 조회 파이프라인(팝빌·국세청·공공구매종합정보망)과 Apick을
// 항상 태워(저장 프로필 short-circuit 없이) 캐시/라이브 원천을 투명하게 드러낸다.
// production 에서는 노출 금지 — 모든 진입점은 assertDevOnly 가드를 통과해야 한다.
// ─────────────────────────────────────────────────────────────────────────────

/** production 환경이면 예외를 던진다(라우트/페이지에서 404·notFound 처리). */
export function assertDevOnly(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-only endpoint");
  }
}

export type ServiceDataFieldSource = "popbill" | "apick" | "nts" | "smpp";
export type ServiceDataProvider = "popbill" | "apick";
export type ServiceDataTraceOrigin = "live" | "cache";

export interface ServiceDataRowSummary {
  provider: string;
  scope: string;
  checkedAt: string | null;
  fetchedAt: string;
  expiresAt: string | null;
  expired: boolean;
  resultCode: string | null;
  resultMessage: string | null;
}

export interface ServiceDataInspectResult {
  bizNo: string;
  maskedBizNo: string;
  provider: ServiceDataProvider | "all";
  hasCache: boolean;
  rows: ServiceDataRowSummary[];
}

export interface ServiceDataField {
  key: string;
  label: string;
  value: string | null;
  source: ServiceDataFieldSource | null;
  confidence: number | null;
  available: boolean;
}

export interface ServiceDataTraceEntry {
  provider: string;
  scope: string;
  origin: ServiceDataTraceOrigin;
  checkedAt: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  resultCode: string | null;
  resultMessage: string | null;
  rawPayload: Record<string, unknown> | null;
  canonicalPayload: Record<string, unknown> | null;
}

export interface ServiceDataLookupError {
  code: string;
  message: string;
  status: number;
}

// ── 22축 커버리지 하네스 (매칭 데이터 소싱 검증) ─────────────────────────────
// 소싱 설계 docs/plans/2026-07-11-matching-data-sourcing.md §4, 키 매니페스트
// docs/plans/2026-07-11-sourcing-keys-manifest.md 를 화면으로 옮긴 상태 모델.

/** 데이터 접근 물리학(소싱 설계 §2): A층=사업자번호 조회, B층=동의·증빙, reserved=예약축. */
export type FieldTier = "A" | "B" | "reserved";

/** 사업자 유형(법인/개인). n/a(법인 전용축) 판정에 쓴다. 사업자번호 중간자리로 추론. */
export type SubjectType = "corporation" | "individual" | "unknown";

/**
 * 필드 상태 모델(키 매니페스트): 키 누락→pending, 데이터 어긋남→failed.
 * self-declared 는 서버가 아니라 클라이언트 Q&A 오버레이가 부여한다(이 함수는 나머지 5개를 결정).
 */
export type FieldCoverageStatus = "self-declared" | "pending" | "live" | "cache" | "failed" | "n/a";

/** 라이브/추론 원천 참조(배지용). */
export type FieldSourceRef = ServiceDataFieldSource | "derived" | "kcomwel" | "fsc" | "nice" | "codef";

/**
 * Phase 2 커넥터가 상태 판정 함수에 넘기는 결과. Phase 1 에선 항상 null 이라 외부소스는 pending 고정.
 * - ok=false | empty | schemaMismatch → computeFieldStatus 가 failed 로 전이.
 * - skipped=true → 조회 전제 미충족(법인번호 없음 등)이라 pending 유지(crash/failed 아님).
 * - ok=true → live. value/confidence/source 는 화면 표시에 사용된다.
 */
export interface ConnectorResult {
  ok: boolean;
  empty?: boolean;
  schemaMismatch?: boolean;
  /** 조회 전제 미충족 → pending 유지(failed 금지). */
  skipped?: boolean;
  reason?: string;
  value?: string | null;
  confidence?: number | null;
  /** 라이브일 때 배지에 표시할 원천. */
  source?: FieldSourceRef;
  /** 라이브 행에 표시할 부가 표식(예: "NICE 데모앱(무계약)"). buildFieldCoverage 가 row.note 로 옮긴다. */
  note?: string | null;
}

export interface FieldCoverageRow {
  /** 행 식별자(축 키 또는 하위 플래그/서브필드 유사키). */
  key: string;
  /** 하위 플래그·서브필드 행이면 소속 축 dimension 키. */
  parentKey: string | null;
  /** 22축 dimension(하위 행은 부모 dimension 을 참조하되 flag/subField 로 구분). */
  dimension: CriterionDimension | null;
  /** 결격 하위 플래그(canonical). 없으면 null. */
  flag: DisqualificationFlag | null;
  /** 재무·고용·투자 하위 서브필드 키. 없으면 null. */
  subField: string | null;
  label: string;
  tier: FieldTier;
  /** 계획 소스 라벨(소싱 설계 §4). 라이브가 아니어도 항상 노출. */
  plannedSource: string;
  status: FieldCoverageStatus;
  value: string | null;
  confidence: number | null;
  /** 라이브/캐시일 때 실제 원천, 그 외 null. */
  source: FieldSourceRef | null;
  /** pending 사유("키 없음"/"배치 파이프라인" 등)·failed 사유. */
  note: string | null;
  /** Q&A 로 채울 수 있는 축인지(클라이언트 오버레이 대상). */
  selfDeclarable: boolean;
}

// 자가신고 Q&A 스키마(canonical 파생). page.tsx(서버 컴포넌트)가 만들어 클라이언트에 props 로 넘긴다
// — 클라이언트 번들에 @cunote/core(서버 코드)를 끌어들이지 않기 위함.
export interface QnaFlagSchema {
  flag: DisqualificationFlag;
  label: string;
}
export interface QnaQuestionSchema {
  id: string;
  label: string;
  flags: QnaFlagSchema[];
}
export interface QnaAxisSchema {
  axis: DisqualificationAxis;
  label: string;
  questions: QnaQuestionSchema[];
}
export interface QnaExceptionSchema {
  key: string;
  label: string;
}
export interface QnaSchema {
  disqualification: QnaAxisSchema[];
  exceptions: QnaExceptionSchema[];
}

export interface ServiceDataLookupResult {
  bizNo: string;
  maskedBizNo: string;
  /** 사업자 유형 추론(법인 전용축 n/a 판정용). */
  subject: SubjectType;
  profile: CompanyProfile | null;
  evidence: CompanyEvidence | null;
  fields: ServiceDataField[];
  /** 22축 + 하위 플래그 커버리지(라이브/pending/n-a 상태). Q&A 는 클라이언트가 오버레이. */
  coverage: FieldCoverageRow[];
  trace: ServiceDataTraceEntry[];
  error?: ServiceDataLookupError;
}

// 필드 키 → confidence 축 매핑(신뢰도 표시용). corp_name 은 축이 없어 null.
const FIELD_DIMENSION: Record<string, CriterionDimension | null> = {
  corp_name: null,
  region: "region",
  biz_age: "biz_age",
  size: "size",
  industry: "industry",
  business_status: "business_status",
  founder_age: "founder_age",
  certification: "certification",
  employees: "employees",
  revenue: "revenue",
};

const POPBILL = { provider: "popbill", scope: "checkBizInfo" } as const;
const NTS = { provider: "nts", scope: "status" } as const;
const SMPP = { provider: "smpp", scope: "certs" } as const;

function maskBizNoSafe(bizNo: string): string {
  try {
    return maskCorpNum(bizNo);
  } catch {
    return "**********";
  }
}

function isExpired(entry: Pick<EnrichmentCacheEntry, "expiresAt">, now: Date): boolean {
  return Boolean(entry.expiresAt && entry.expiresAt.getTime() <= now.getTime());
}

function toRowSummary(entry: EnrichmentCacheEntry, now: Date): ServiceDataRowSummary {
  return {
    provider: entry.provider,
    scope: entry.scope,
    checkedAt: entry.checkedAt?.toISOString() ?? null,
    fetchedAt: entry.fetchedAt.toISOString(),
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    expired: isExpired(entry, now),
    resultCode: entry.providerResultCode ?? null,
    resultMessage: entry.providerResultMessage ?? null,
  };
}

/** 만료 여부와 무관하게 사업자번호에 걸린 전체 캐시 행을 요약해 반환한다. */
export async function inspectServiceData(
  bizNo: string,
  provider?: ServiceDataProvider,
): Promise<ServiceDataInspectResult> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;
  const rows = visibleCacheRows(await cache.listByBizNo(normalized), provider);
  const now = new Date();
  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    provider: provider ?? "all",
    hasCache: rows.length > 0,
    rows: rows.map((row) => toRowSummary(row, now)),
  };
}

/** 사업자번호(옵션: provider)로 캐시를 비우고 삭제 행 수를 반환한다. */
export async function clearServiceDataCache(
  bizNo: string,
  provider?: ServiceDataProvider,
): Promise<{ deleted: number }> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;
  const rows = visibleCacheRows(await cache.listByBizNo(normalized), provider);
  let deleted = 0;
  for (const row of rows) {
    deleted += await cache.deleteByBizNo({
      bizNo: normalized,
      provider: row.provider,
      scope: row.scope,
    });
  }
  return { deleted };
}

function snapshotKey(provider: string, scope: string): string {
  return `${provider}:${scope}`;
}

function parsePopbillProfile(payload: Record<string, unknown> | null | undefined): CompanyProfile | null {
  if (!payload) return null;
  const profile = (payload as { profile?: unknown }).profile;
  return profile && typeof profile === "object" ? (profile as CompanyProfile) : null;
}

/**
 * 조회 파이프라인을 항상 실행(저장 프로필 우회 없음)하고, 캐시/라이브 원천을 재구성해 돌려준다.
 * - forceRefresh: 사업자번호에 걸린 캐시를 먼저 전부 비우고 조회 → 전 provider 라이브 재호출.
 * - before/after fetchedAt 스냅샷 비교로 provider 별 live/cache 판정.
 */
export async function lookupServiceData(
  bizNo: string,
  options: { forceRefresh?: boolean; provider?: ServiceDataProvider } = {},
): Promise<ServiceDataLookupResult> {
  const normalized = sanitizeCorpNum(bizNo);
  if (options.provider === "apick") {
    return lookupApickServiceData(normalized, options);
  }

  const cache = getServiceRepositories().enrichmentCache;

  if (options.forceRefresh) {
    await clearServiceDataCache(normalized, "popbill");
  }

  // before 스냅샷: provider:scope → fetchedAt(ms). 이번 요청에서 재호출됐는지 판정 기준.
  const beforeRows = visibleCacheRows(await cache.listByBizNo(normalized), "popbill");
  const beforeFetched = new Map<string, number>();
  for (const row of beforeRows) {
    beforeFetched.set(snapshotKey(row.provider, row.scope), row.fetchedAt.getTime());
  }

  let profile: CompanyProfile | null = null;
  let evidence: CompanyEvidence | null = null;
  let error: ServiceDataLookupError | undefined;
  try {
    const resolution = await loadCompanyProfileFromSourceWithEvidence(normalized);
    profile = resolution.profile;
    evidence = resolution.evidence;
  } catch (caught) {
    // 폐업·미등록·캐시 불가 등 의미 있는 오류는 트레이스는 보여주되 흐름은 계속한다.
    if (caught instanceof ServiceDataError) {
      error = { code: caught.code, message: caught.message, status: caught.status };
    } else {
      throw caught;
    }
  }

  // after 스냅샷: 파이프라인이 채운(또는 재사용한) 캐시 행 전체.
  const afterRows = visibleCacheRows(await cache.listByBizNo(normalized), "popbill");
  const now = new Date();
  const rowByKey = new Map<string, EnrichmentCacheEntry>();
  for (const row of afterRows) {
    rowByKey.set(snapshotKey(row.provider, row.scope), row);
  }

  const trace: ServiceDataTraceEntry[] = afterRows.map((row) => {
    const key = snapshotKey(row.provider, row.scope);
    const before = beforeFetched.get(key);
    // before 에 없거나 fetchedAt 이 바뀌었으면 이번 요청에서 원소스를 실호출한 것(live).
    const origin: ServiceDataTraceOrigin =
      before === undefined || before !== row.fetchedAt.getTime() ? "live" : "cache";
    return {
      provider: row.provider,
      scope: row.scope,
      origin,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, now),
      resultCode: row.providerResultCode ?? null,
      resultMessage: row.providerResultMessage ?? null,
      rawPayload: row.rawPayload ?? null,
      canonicalPayload: row.canonicalPayload ?? null,
    };
  });

  // 필드 원천 재구성(순수 함수 재적용). 팝빌 profile 을 base 로, NTS 휴·폐업이면 영업상태 원천=nts,
  // SMPP 확인서가 실제로 프로필을 바꿨으면(addedLabels) 인증/특성 원천=smpp.
  const popbillRow = rowByKey.get(snapshotKey(POPBILL.provider, POPBILL.scope));
  const popbillProfile = parsePopbillProfile(popbillRow?.canonicalPayload);
  const hasPopbill = Boolean(popbillRow);

  const ntsRow = rowByKey.get(snapshotKey(NTS.provider, NTS.scope));
  const ntsStatus = (ntsRow?.canonicalPayload ?? null) as NtsBusinessStatusData | null;
  const ntsClosed = ntsStatus ? ntsClosedLabel(ntsStatus.b_stt_cd) : null;

  const smppRow = rowByKey.get(snapshotKey(SMPP.provider, SMPP.scope));
  const smppCerts = (smppRow?.canonicalPayload ?? null) as SmppCertificates | null;
  const smppAddedLabels =
    popbillProfile && smppCerts
      ? applySmppCertificatesToProfile(popbillProfile, smppCerts).addedLabels
      : [];
  const smppChanged = smppAddedLabels.length > 0;

  const fieldSource = (key: string, available: boolean): ServiceDataFieldSource | null => {
    if (!available) return null;
    if (key === "business_status") {
      if (ntsClosed) return "nts";
      return hasPopbill ? "popbill" : null;
    }
    if (key === "certification") {
      return smppChanged ? "smpp" : hasPopbill ? "popbill" : null;
    }
    // 나머지 축(상호·소재지·업력·기업규모·업종 등)은 팝빌이 base.
    return hasPopbill ? "popbill" : null;
  };

  const confidenceFor = (key: string): number | null => {
    const dimension = FIELD_DIMENSION[key];
    if (!dimension || !profile?.confidence) return null;
    const value = profile.confidence[dimension];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  // evidence.fields 는 파이프라인이 최종 프로필로 계산한 10개 축(키/라벨/값/available)이라 그대로 재사용한다.
  const fields: ServiceDataField[] = (evidence?.fields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    value: field.value,
    available: field.available,
    source: fieldSource(field.key, field.available),
    confidence: confidenceFor(field.key),
  }));

  const subject = resolveSubjectType(normalized);
  const connectorResults = await runExternalConnectors({ bizNo: normalized, subject, profile });
  const coverage = buildFieldCoverage({
    subject,
    profile,
    fields,
    originBySource: originBySourceFromTrace(trace),
    connectorResults,
  });

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    subject,
    profile,
    evidence,
    fields,
    coverage,
    trace,
    ...(error ? { error } : {}),
  };
}

async function lookupApickServiceData(
  bizNo: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ServiceDataLookupResult> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;

  const beforeRows = visibleCacheRows(await cache.listByBizNo(normalized), "apick");
  const beforeFetched = new Map<string, number>();
  for (const row of beforeRows) {
    beforeFetched.set(snapshotKey(row.provider, row.scope), row.fetchedAt.getTime());
  }

  let profile: CompanyProfile | null = null;
  let evidence: CompanyEvidence | null = null;
  let error: ServiceDataLookupError | undefined;
  try {
    const resolution = await loadApickBizDetailCompanyProfile({
      bizNo: normalized,
      cache,
      ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    });
    profile = resolution.profile;
    evidence = resolution.evidence;
  } catch (caught) {
    if (caught instanceof ServiceDataError) {
      error = { code: caught.code, message: caught.message, status: caught.status };
    } else {
      throw caught;
    }
  }

  const afterRows = visibleCacheRows(await cache.listByBizNo(normalized), "apick");
  const trace = buildTrace(afterRows, beforeFetched);
  const fields: ServiceDataField[] = (evidence?.fields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    value: field.value,
    available: field.available,
    source: field.available ? "apick" : null,
    confidence: confidenceForProfileField(profile, field.key),
  }));

  const subject = resolveSubjectType(normalized);
  const connectorResults = await runExternalConnectors({ bizNo: normalized, subject, profile });
  const coverage = buildFieldCoverage({
    subject,
    profile,
    fields,
    originBySource: originBySourceFromTrace(trace),
    connectorResults,
  });

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    subject,
    profile,
    evidence,
    fields,
    coverage,
    trace,
    ...(error ? { error } : {}),
  };
}

function buildTrace(
  rows: EnrichmentCacheEntry[],
  beforeFetched: Map<string, number>,
): ServiceDataTraceEntry[] {
  const now = new Date();
  return rows.map((row) => {
    const key = snapshotKey(row.provider, row.scope);
    const before = beforeFetched.get(key);
    const origin: ServiceDataTraceOrigin =
      before === undefined || before !== row.fetchedAt.getTime() ? "live" : "cache";
    return {
      provider: row.provider,
      scope: row.scope,
      origin,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, now),
      resultCode: row.providerResultCode ?? null,
      resultMessage: row.providerResultMessage ?? null,
      rawPayload: row.rawPayload ?? null,
      canonicalPayload: row.canonicalPayload ?? null,
    };
  });
}

function visibleCacheRows(
  rows: EnrichmentCacheEntry[],
  provider?: ServiceDataProvider,
): EnrichmentCacheEntry[] {
  return rows.filter((row) => {
    if (isApickGuard(row)) return false;
    if (!provider) return true;
    if (provider === "apick") {
      return row.provider === APICK_BIZ_DETAIL.provider && row.scope === APICK_BIZ_DETAIL.scope;
    }
    return row.provider === POPBILL.provider || row.provider === NTS.provider || row.provider === SMPP.provider;
  });
}

function isApickGuard(row: Pick<EnrichmentCacheEntry, "provider" | "scope">): boolean {
  return row.provider === APICK_BIZ_DETAIL_GUARD.provider && row.scope === APICK_BIZ_DETAIL_GUARD.scope;
}

function confidenceForProfileField(profile: CompanyProfile | null, key: string): number | null {
  const dimension = FIELD_DIMENSION[key];
  if (!dimension || !profile?.confidence) return null;
  const value = profile.confidence[dimension];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 22축 커버리지 하네스 — 무키(Phase 1) 뼈대
// 기존 라이브 소스(팝빌/NTS/SMPP/Apick)는 그대로 live/cache 로 동작(회귀 금지).
// 신규 외부소스(kcomwel·금융위·NICE·CODEF·명단 배치)는 커넥터 미배선이라 pending 고정 —
// 상태 판정은 computeFieldStatus 한 곳으로 수렴하고, Phase 2 커넥터가 connectorResults 로
// 결과를 넘기면 env 있음+에러/빈값/스키마 불일치 → failed 로 전이한다.
// ─────────────────────────────────────────────────────────────────────────────

// 계획 소스별 env 키(키 매니페스트 §B~D). 전부 존재해야 envPresent=true.
const ENV_KCOMWEL = ["CUNOTE_KCOMWEL_SERVICE_KEY"] as const;
const ENV_FSC = ["CUNOTE_FSC_FINANCE_SERVICE_KEY"] as const;
const ENV_MOEL = ["CUNOTE_MOEL_ACCIDENT_SERVICE_KEY"] as const;
const ENV_NICE = ["NICE_BIZ_CLIENT_APP_KEY", "NICE_BIZ_CLIENT_SECRET"] as const;
const ENV_CODEF = ["CODEF_CLIENT_ID", "CODEF_CLIENT_SECRET"] as const;
const ENV_KIPRIS = ["KIPRIS_SERVICE_KEY"] as const;

interface CoveragePlanEntry {
  key: string;
  parentKey: string | null;
  dimension: CriterionDimension | null;
  flag: DisqualificationFlag | null;
  subField: string | null;
  label: string;
  tier: FieldTier;
  plannedSource: string;
  /** evidence.fields 의 키(이미 배선된 라이브 소스가 채우는 축). */
  liveKey: string | null;
  /** 라이브 소스는 아니나 프로필/사업자번호에서 파생하는 축. */
  derived: "target_type" | "founder_trait" | null;
  /** 계획 외부소스의 env 키. */
  envKeys: readonly string[] | null;
  /** 배치 파이프라인(런타임 키 없음). */
  batch: boolean;
  /** 법인 전용축(개인 && !selfDeclarable → n/a). */
  corpOnly: boolean;
  /** 예약축(항상 n/a). */
  reserved: boolean;
  /** Q&A 로 채울 수 있는지. */
  selfDeclarable: boolean;
}

function planRow(
  e: Partial<CoveragePlanEntry> &
    Pick<CoveragePlanEntry, "key" | "label" | "tier" | "plannedSource">,
): CoveragePlanEntry {
  return {
    parentKey: null,
    dimension: null,
    flag: null,
    subField: null,
    liveKey: null,
    derived: null,
    envKeys: null,
    batch: false,
    corpOnly: false,
    reserved: false,
    selfDeclarable: false,
    ...e,
  };
}

// canonical 라벨을 재사용한 결격 하위 플래그 행 팩토리.
function flagRow(
  parentKey: DisqualificationAxis,
  flag: DisqualificationFlag,
  opts: {
    tier: FieldTier;
    plannedSource: string;
    envKeys?: readonly string[];
    batch?: boolean;
    corpOnly?: boolean;
  },
): CoveragePlanEntry {
  return planRow({
    key: `${parentKey}.${flag}`,
    parentKey,
    dimension: parentKey,
    flag,
    label: DISQUALIFICATION_FLAG_LABELS[flag],
    tier: opts.tier,
    plannedSource: opts.plannedSource,
    ...(opts.envKeys ? { envKeys: opts.envKeys } : {}),
    ...(opts.batch ? { batch: opts.batch } : {}),
    ...(opts.corpOnly ? { corpOnly: opts.corpOnly } : {}),
    selfDeclarable: true,
  });
}

const NICE_CORP = { tier: "A" as const, plannedSource: "NICE OCCD03(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true };

/** 22축(CRITERION_DIMENSIONS 순) + 하위 플래그·서브필드 커버리지 플랜. */
const FIELD_COVERAGE_PLAN: readonly CoveragePlanEntry[] = [
  planRow({ key: "region", dimension: "region", label: "소재지", tier: "A", plannedSource: "팝빌 주소", liveKey: "region" }),
  planRow({ key: "biz_age", dimension: "biz_age", label: "업력", tier: "A", plannedSource: "팝빌 개업일", liveKey: "biz_age" }),
  planRow({ key: "industry", dimension: "industry", label: "업종", tier: "A", plannedSource: "팝빌 업태·종목 → KSIC", liveKey: "industry" }),
  planRow({ key: "size", dimension: "size", label: "기업규모", tier: "A", plannedSource: "팝빌 기업규모(근사)", liveKey: "size" }),
  planRow({ key: "revenue", dimension: "revenue", label: "매출액", tier: "A", plannedSource: "금융위 재무 V2(법인) · CODEF(개인) · 자가신고", liveKey: "revenue", envKeys: ENV_FSC, selfDeclarable: true }),
  planRow({ key: "employees", dimension: "employees", label: "상시근로자", tier: "A", plannedSource: "근로복지공단 15059256 · 자가신고", liveKey: "employees", envKeys: ENV_KCOMWEL, selfDeclarable: true }),
  planRow({ key: "founder_age", dimension: "founder_age", label: "대표자 연령", tier: "B", plannedSource: "CODEF 간편인증 · 자가신고", liveKey: "founder_age", envKeys: ENV_CODEF, selfDeclarable: true }),
  planRow({ key: "founder_trait", dimension: "founder_trait", label: "대표자 특성", tier: "A", plannedSource: "SMPP(여성·장애인) · 자가신고(청년·시니어)", derived: "founder_trait", selfDeclarable: true }),
  planRow({ key: "certification", dimension: "certification", label: "보유 인증·확인서", tier: "A", plannedSource: "SMPP + 공개명단 배치 · 자가신고", liveKey: "certification", selfDeclarable: true }),
  planRow({ key: "prior_award", dimension: "prior_award", label: "수혜 이력", tier: "B", plannedSource: "통합 API 없음 · 자가신고", selfDeclarable: true }),
  planRow({ key: "ip", dimension: "ip", label: "지식재산권", tier: "B", plannedSource: "KIPRIS Plus · 자가신고", envKeys: ENV_KIPRIS, selfDeclarable: true }),
  planRow({ key: "target_type", dimension: "target_type", label: "대상 유형(법인/개인)", tier: "A", plannedSource: "사업자번호 추론 · 자가신고(예비창업)", derived: "target_type", selfDeclarable: true }),
  planRow({ key: "business_status", dimension: "business_status", label: "영업상태", tier: "A", plannedSource: "국세청 · 팝빌", liveKey: "business_status" }),

  // ── tax_compliance (납세 결격) ──
  planRow({ key: "tax_compliance", dimension: "tax_compliance", label: "납세 결격", tier: "A", plannedSource: "NICE OCCD03/01(법인) · CODEF(개인) · 자가신고", selfDeclarable: true }),
  flagRow("tax_compliance", "national_tax_delinquent", NICE_CORP),
  flagRow("tax_compliance", "local_tax_delinquent", NICE_CORP),
  flagRow("tax_compliance", "customs_delinquent", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("tax_compliance", "social_insurance_delinquent", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),

  // ── credit_status (신용 결격) ──
  planRow({ key: "credit_status", dimension: "credit_status", label: "신용 결격", tier: "A", plannedSource: "NICE OCCD03/06/01(법인) · 자가신고", selfDeclarable: true }),
  flagRow("credit_status", "credit_delinquency", NICE_CORP),
  flagRow("credit_status", "loan_default", NICE_CORP),
  flagRow("credit_status", "bond_default", { tier: "A", plannedSource: "NICE OCCD01 당좌정지(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "rehabilitation_in_progress", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "bankruptcy_filed", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "court_receivership", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "financial_misconduct", NICE_CORP),
  flagRow("credit_status", "asset_seizure", { tier: "B", plannedSource: "OCCD 미커버 · 자가신고" }),
  flagRow("credit_status", "guarantee_restricted", { tier: "B", plannedSource: "OCCD 미커버 · 자가신고" }),

  // ── sanction (제재·명단 결격) ──
  planRow({ key: "sanction", dimension: "sanction", label: "제재·명단 결격", tier: "A", plannedSource: "조달청 CSV + 명단 배치 · 자가신고", selfDeclarable: true }),
  flagRow("sanction", "participation_restricted", { tier: "A", plannedSource: "조달청 부정당제재 CSV 15137996(배치·사업자번호)", batch: true }),
  flagRow("sanction", "wage_arrears_listed", { tier: "A", plannedSource: "고용부 체불 명단(배치·상호 퍼지)", batch: true }),
  flagRow("sanction", "serious_accident_listed", { tier: "A", plannedSource: "중대재해 15090150(상호 퍼지)", envKeys: ENV_MOEL }),
  flagRow("sanction", "subsidy_fraud", { tier: "B", plannedSource: "IRIS 폐쇄형 · 자가신고" }),
  flagRow("sanction", "subsidy_law_violation", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("sanction", "obligation_breach", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("sanction", "agreement_breach", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),

  // ── financial_health (재무건전성) ──
  planRow({ key: "financial_health", dimension: "financial_health", label: "재무건전성", tier: "A", plannedSource: "금융위 재무 V2 · NICE OCOV06(법인)", selfDeclarable: true }),
  planRow({ key: "financial_health.debt_ratio_pct", parentKey: "financial_health", dimension: "financial_health", subField: "debt_ratio_pct", label: "부채비율", tier: "A", plannedSource: "금융위 재무 V2(법인)", envKeys: ENV_FSC, corpOnly: true }),
  planRow({ key: "financial_health.impairment", parentKey: "financial_health", dimension: "financial_health", subField: "impairment", label: "자본잠식", tier: "A", plannedSource: "금융위 재무 V2 파생 · 자가신고", envKeys: ENV_FSC, corpOnly: true, selfDeclarable: true }),
  planRow({ key: "financial_health.total_assets_krw", parentKey: "financial_health", dimension: "financial_health", subField: "total_assets_krw", label: "자산총계", tier: "A", plannedSource: "금융위 재무 V2(법인)", envKeys: ENV_FSC, corpOnly: true }),
  planRow({ key: "financial_health.equity_krw", parentKey: "financial_health", dimension: "financial_health", subField: "equity_krw", label: "자본총계", tier: "A", plannedSource: "금융위 재무 V2 · 자가신고", envKeys: ENV_FSC, corpOnly: true, selfDeclarable: true }),

  // ── insured_workforce (고용보험 가입) ──
  planRow({ key: "insured_workforce", dimension: "insured_workforce", label: "고용보험 가입", tier: "A", plannedSource: "근로복지공단(성립) · CODEF(피보험자수) · 자가신고", selfDeclarable: true }),
  planRow({ key: "insured_workforce.employment_insurance_active", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "employment_insurance_active", label: "고용보험 성립여부", tier: "A", plannedSource: "근로복지공단 15059256", envKeys: ENV_KCOMWEL }),
  planRow({ key: "insured_workforce.insured_count", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "insured_count", label: "피보험자수", tier: "B", plannedSource: "CODEF 4대보험 명부(인증서)", envKeys: ENV_CODEF }),
  planRow({ key: "insured_workforce.no_layoff", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "no_layoff", label: "감원 이력", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),

  // ── investment (투자 유치) ──
  planRow({ key: "investment", dimension: "investment", label: "투자 유치", tier: "A", plannedSource: "jointips 명단 배치 · 자가신고", selfDeclarable: true }),
  planRow({ key: "investment.tips_backed", parentKey: "investment", dimension: "investment", subField: "tips_backed", label: "TIPS 선정", tier: "A", plannedSource: "jointips.or.kr 명단(배치·기업명 퍼지)", batch: true, selfDeclarable: true }),
  planRow({ key: "investment.total_raised_krw", parentKey: "investment", dimension: "investment", subField: "total_raised_krw", label: "누적 투자금", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),
  planRow({ key: "investment.last_round", parentKey: "investment", dimension: "investment", subField: "last_round", label: "투자 라운드", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),

  // ── 예약축 ──
  planRow({ key: "premises", dimension: "premises", label: "사업장(예약)", tier: "reserved", plannedSource: "법인등기·건축물대장(defer)", reserved: true }),
  planRow({ key: "export_performance", dimension: "export_performance", label: "수출실적(예약)", tier: "reserved", plannedSource: "무역협회·관세청 유니패스(defer)", reserved: true }),

  // ── other ──
  planRow({ key: "other", dimension: "other", label: "기타 조건", tier: "B", plannedSource: "Q&A 자유입력", selfDeclarable: true }),
];

/** 사업자번호 중간 2자리로 법인/개인 추론(81~88=법인격). */
export function resolveSubjectType(bizNo: string): SubjectType {
  const digits = bizNo.replace(/\D/g, "");
  if (digits.length !== 10) return "unknown";
  const mid = Number(digits.slice(3, 5));
  if (!Number.isFinite(mid)) return "unknown";
  return mid >= 81 && mid <= 88 ? "corporation" : "individual";
}

function envPresent(keys: readonly string[]): boolean {
  return keys.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function originBySourceFromTrace(
  trace: ServiceDataTraceEntry[],
): Map<string, ServiceDataTraceOrigin> {
  const map = new Map<string, ServiceDataTraceOrigin>();
  for (const entry of trace) {
    if (!map.has(entry.provider)) map.set(entry.provider, entry.origin);
  }
  return map;
}

/**
 * 필드 상태 결정 — 5개 상태(n/a·live·cache·failed·pending)의 단일 판정점.
 * self-declared 는 클라이언트 Q&A 오버레이가 부여한다.
 * Phase 2 훅: external.result 가 채워지면(env 있음+커넥터 호출) 에러/빈값/스키마 불일치→failed.
 * Phase 1 은 external.result=null 로 외부소스를 pending 고정한다.
 */
export function computeFieldStatus(input: {
  reserved: boolean;
  corpOnly: boolean;
  subject: SubjectType;
  selfDeclarable: boolean;
  live: { available: boolean; origin: ServiceDataTraceOrigin } | null;
  external: { envPresent: boolean; batch: boolean; result: ConnectorResult | null } | null;
}): { status: FieldCoverageStatus; note: string | null } {
  if (input.reserved) return { status: "n/a", note: "예약축 · 판정 비활성" };
  if (input.corpOnly && input.subject === "individual" && !input.selfDeclarable) {
    return { status: "n/a", note: "법인 전용축 · 개인사업자 대상 아님" };
  }
  if (input.live?.available) {
    return { status: input.live.origin === "cache" ? "cache" : "live", note: null };
  }
  // 법인 소스가 커버 못 하는 개인사업자 결격/재무 축은 Q&A 로만 채운다.
  if (input.corpOnly && input.subject === "individual") {
    return { status: "pending", note: "개인 DB 없음 · 자가신고 대기" };
  }
  if (input.external) {
    const result = input.external.result;
    if (result !== null) {
      // Phase 2: 커넥터가 결과를 넘김.
      // skipped: 조회 전제 미충족(법인번호 없음 등) → pending 유지(사유 노출).
      if (result.skipped) {
        return { status: "pending", note: result.reason ?? "조회 전제 미충족" };
      }
      if (!result.ok || result.empty || result.schemaMismatch) {
        return { status: "failed", note: result.reason ?? "응답 에러 · 빈값 · 스키마 불일치" };
      }
      return { status: "live", note: null };
    }
    // Phase 1: 커넥터 미배선 → pending 고정.
    if (input.external.batch) return { status: "pending", note: "배치 파이프라인 · Phase 2 배선 예정" };
    return {
      status: "pending",
      note: input.external.envPresent ? "키 있음 · 커넥터 Phase 2 배선 대기" : "키 없음",
    };
  }
  return { status: "pending", note: input.selfDeclarable ? "자가신고 대기" : "미배선" };
}

/**
 * 22축 + 하위 행 커버리지 산출. 라이브 소스가 채운 필드는 live/cache 로,
 * 신규 외부소스는 pending 으로, 법인 전용축의 개인사업자는 n/a 로 렌더한다.
 * @param connectorResults Phase 2 커넥터 결과 맵(entry.key → ConnectorResult). Phase 1 은 미전달.
 */
export function buildFieldCoverage(input: {
  subject: SubjectType;
  profile: CompanyProfile | null;
  fields: ServiceDataField[];
  originBySource: Map<string, ServiceDataTraceOrigin>;
  connectorResults?: Map<string, ConnectorResult>;
}): FieldCoverageRow[] {
  const fieldByKey = new Map(input.fields.map((field) => [field.key, field]));
  const originForSource = (source: ServiceDataFieldSource | null): ServiceDataTraceOrigin =>
    (source ? input.originBySource.get(source) : undefined) ?? "live";

  return FIELD_COVERAGE_PLAN.map((entry) => {
    let live: { available: boolean; origin: ServiceDataTraceOrigin } | null = null;
    let value: string | null = null;
    let source: FieldSourceRef | null = null;
    let confidence: number | null = null;

    if (entry.liveKey) {
      const field = fieldByKey.get(entry.liveKey);
      if (field) {
        live = { available: field.available, origin: originForSource(field.source) };
        value = field.available ? field.value : null;
        source = field.source;
        confidence = field.confidence;
      }
    } else if (entry.derived === "founder_trait") {
      const traits = input.profile?.traits ?? [];
      if (traits.length > 0) {
        live = { available: true, origin: originForSource("smpp") };
        value = traits.join(", ");
        source = "smpp";
        confidence = input.profile?.confidence?.founder_trait ?? 0.6;
      }
    } else if (entry.derived === "target_type") {
      if (input.subject !== "unknown") {
        live = { available: true, origin: "live" };
        value = input.subject === "corporation" ? "법인" : "개인사업자";
        source = "derived";
        confidence = 0.6;
      }
    }

    const connectorResult = input.connectorResults?.get(entry.key) ?? null;
    // CODEF 국세청 확정값은 최우선(handoff §5: codef > popbill/apick > derived/자가신고).
    // 팝빌 라이브키나 derived(target_type·founder_trait)가 먼저 채워도, codef 커넥터 결과가 있으면
    // 그 행을 국세청(CODEF)로 덮어쓴다. envKeys 게이팅과 무관하게(라이브키/파생축 포함) 병합된다.
    const codefOverride =
      connectorResult?.ok && connectorResult.source === "codef" ? connectorResult : null;
    const external =
      entry.envKeys || entry.batch
        ? {
            envPresent: entry.envKeys ? envPresent(entry.envKeys) : false,
            batch: entry.batch,
            result: connectorResult,
          }
        : null;

    const { status, note } = computeFieldStatus({
      reserved: entry.reserved,
      corpOnly: entry.corpOnly,
      subject: input.subject,
      selfDeclarable: entry.selfDeclarable,
      live,
      external,
    });

    const isLive = status === "live" || status === "cache";
    let rowNote = note;
    // 커넥터가 live 를 채웠으면(라이브 소스 필드가 아니라 외부 커넥터) 값/원천은 커넥터 결과에서 온다.
    if (isLive && !live?.available && connectorResult?.ok) {
      value = connectorResult.value ?? null;
      confidence = connectorResult.confidence ?? null;
      source = connectorResult.source ?? null;
      // 커넥터가 표식 note 를 실었으면(예: "NICE 데모앱(무계약)") live 행에도 노출한다.
      if (connectorResult.note) rowNote = connectorResult.note;
    }
    // CODEF 국세청 확정값이 있으면 라이브키/파생/외부 결과를 덮어 최우선으로 표시한다.
    // 커넥터가 라이브 호출이 아니라 company_enrichment_cache passive 판독이므로 status는 "cache"
    // (인증은 api/dev/codef/* 에서 선행돼 캐시에 남았고, 이 행은 그 캐시를 재사용해 표시한다).
    if (codefOverride) {
      return {
        key: entry.key,
        parentKey: entry.parentKey,
        dimension: entry.dimension,
        flag: entry.flag,
        subField: entry.subField,
        label: entry.label,
        tier: entry.tier,
        plannedSource: entry.plannedSource,
        selfDeclarable: entry.selfDeclarable,
        status: "cache",
        value: codefOverride.value ?? null,
        confidence: codefOverride.confidence ?? null,
        source: "codef",
        note: codefOverride.note ?? null,
      };
    }
    return {
      key: entry.key,
      parentKey: entry.parentKey,
      dimension: entry.dimension,
      flag: entry.flag,
      subField: entry.subField,
      label: entry.label,
      tier: entry.tier,
      plannedSource: entry.plannedSource,
      selfDeclarable: entry.selfDeclarable,
      status,
      value: isLive ? value : null,
      confidence: isLive ? confidence : null,
      source: isLive ? source : null,
      note: rowNote,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — data.go.kr 커넥터 배선(dev 전용, 프로덕션 오버레이 체인 미접촉).
// kcomwel(고용·산재 15059256) · 금융위 기업재무(15043459) · 금융위 개인사업자재무(15108171).
// 각 커넥터 결과를 필드 키별 ConnectorResult 로 만들어 buildFieldCoverage 에 주입 →
// 값 있으면 live, 에러/빈값/스키마불일치 failed, 조회 전제 미충족(법인번호 없음) skip→pending.
// ─────────────────────────────────────────────────────────────────────────────

/** apick 상세가 실어 준 법인등록번호(13자리)를 프로필에서 추출. 없으면 null(팝빌 경로엔 없음). */
function extractCorpRegNo(profile: CompanyProfile | null): string | null {
  const raw = profile?.other_conditions?.["apick_corporate_registration_no"];
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

function connectorErrorReason(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

/** 원(₩) 금액을 억/만원 한글 표기로 압축(음수·0 포함). */
function formatKrwCompact(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 100_000_000) {
    const eok = Math.round((abs / 100_000_000) * 10) / 10;
    return `${sign}${eok.toLocaleString("ko-KR")}억원`;
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000).toLocaleString("ko-KR")}만원`;
  return `${sign}${abs.toLocaleString("ko-KR")}원`;
}

/**
 * dev 조회 경로에서만 실행되는 외부 커넥터 오케스트레이터. 필드 키 → ConnectorResult 맵을 만든다.
 * - 각 커넥터는 fail-open(내부 try/catch) — 절대 throw 하지 않아 lookup 흐름을 깨지 않는다.
 * - 키 미설정 소스는 아무 결과도 넣지 않아 pending("키 없음") 을 유지한다.
 */
export async function runExternalConnectors(input: {
  bizNo: string;
  subject: SubjectType;
  profile: CompanyProfile | null;
}): Promise<Map<string, ConnectorResult>> {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("./loadMonorepoEnv");
    loadMonorepoEnv();
  }
  const results = new Map<string, ConnectorResult>();
  await Promise.all([
    runKcomwelConnector(input.bizNo, results),
    runFscCorpFinanceConnector(input, results),
    runFscPersonalFinanceConnector(input, results),
    runNiceConnector(input, results),
    runCodefConnector(input.bizNo, results),
  ]);
  return results;
}

/** kcomwel 고용·산재(15059256) → employees · insured_workforce.employment_insurance_active. */
async function runKcomwelConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_KCOMWEL_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지
  const employeesKey = "employees";
  const insuredKey = "insured_workforce.employment_insurance_active";
  try {
    const summary = await checkKcomwelEmployment({ serviceKey, bizNo, kind: "employment" });
    if (!summary) {
      const empty: ConnectorResult = { ok: false, empty: true, reason: "고용보험 가입 사업장 없음" };
      results.set(employeesKey, empty);
      results.set(insuredKey, empty);
      return;
    }
    if (typeof summary.totalWorkers === "number") {
      results.set(employeesKey, {
        ok: true,
        value: `${summary.totalWorkers.toLocaleString("ko-KR")}명${summary.siteCount > 1 ? ` (${summary.siteCount}개 사업장)` : ""}`,
        confidence: 0.7,
        source: "kcomwel",
      });
    } else {
      results.set(employeesKey, { ok: false, empty: true, reason: "상시인원 미제공" });
    }
    const seongrip = summary.earliestSeongripDt
      ? `${summary.earliestSeongripDt.slice(0, 4)}-${summary.earliestSeongripDt.slice(4, 6)}-${summary.earliestSeongripDt.slice(6, 8)}`
      : null;
    results.set(insuredKey, {
      ok: true,
      value: summary.insuranceActive ? `성립${seongrip ? ` (${seongrip})` : ""}` : "미성립",
      confidence: 0.7,
      source: "kcomwel",
    });
  } catch (error) {
    const failed: ConnectorResult = { ok: false, reason: connectorErrorReason(error) };
    results.set(employeesKey, failed);
    results.set(insuredKey, failed);
  }
}

const FSC_CORP_FIELD_KEYS = [
  "revenue",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
] as const;

/** 금융위 기업재무(15043459) → revenue · financial_health.*. 법인 && 법인등록번호 브리지 필요. */
async function runFscCorpFinanceConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  if (input.subject !== "corporation") return; // 법인 전용
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_FSC_FINANCE_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지

  const corpRegNo = extractCorpRegNo(input.profile);
  if (!corpRegNo) {
    // 법인등록번호 없음 → skip(pending 유지). 팝빌 경로엔 법인번호가 없어 apick 조회 시에만 채워진다.
    const skipped: ConnectorResult = {
      ok: false,
      skipped: true,
      reason: "법인등록번호 없음 · apick 조회 경로에서만 브리지",
    };
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, skipped);
    return;
  }

  try {
    const summary = await checkFscCorpFinance({ serviceKey, corpRegNo });
    if (!summary) {
      const empty: ConnectorResult = { ok: false, empty: true, reason: "금융위 재무 데이터 없음(crno 미등재)" };
      for (const key of FSC_CORP_FIELD_KEYS) results.set(key, empty);
      return;
    }
    const yearTag = summary.bizYear ? ` (${summary.bizYear})` : "";
    setNumericField(results, "revenue", formatKrwCompact(summary.saleAmt), 0.85, yearTag);
    setNumericField(
      results,
      "financial_health.debt_ratio_pct",
      summary.debtRatioPct !== null ? `${summary.debtRatioPct.toLocaleString("ko-KR")}%` : null,
      0.85,
      yearTag,
    );
    results.set("financial_health.impairment", {
      ok: true,
      value: `${summary.impaired ? "자본잠식" : "정상"}${yearTag}`,
      confidence: 0.85,
      source: "fsc",
    });
    setNumericField(results, "financial_health.total_assets_krw", formatKrwCompact(summary.totalAssets), 0.85, yearTag);
    setNumericField(results, "financial_health.equity_krw", formatKrwCompact(summary.totalEquity), 0.85, yearTag);
  } catch (error) {
    const failed: ConnectorResult = { ok: false, reason: connectorErrorReason(error) };
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, failed);
  }
}

/** 값이 있으면 live, 없으면 empty(failed)로 세팅. */
function setNumericField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  confidence: number,
  yearTag: string,
): void {
  if (value === null) {
    results.set(key, { ok: false, empty: true, reason: "값 미제공" });
    return;
  }
  results.set(key, { ok: true, value: `${value}${yearTag}`, confidence, source: "fsc" });
}

/**
 * 금융위 개인사업자재무(15108171) → revenue(개인).
 * 실측 반증: 익명 집계셋이라 사업자번호 조회 불가 → schemaMismatch(failed)로 사실을 노출.
 */
async function runFscPersonalFinanceConnector(
  input: { bizNo: string; subject: SubjectType },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  if (input.subject !== "individual") return; // 개인사업자 전용
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_FSC_FINANCE_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지
  try {
    const classification = await checkFscPersonalFinance({ serviceKey, bizNo: input.bizNo });
    if (classification.kind === "aggregate") {
      results.set("revenue", {
        ok: false,
        schemaMismatch: true,
        reason: `익명 집계셋(전체 ${classification.totalCount?.toLocaleString("ko-KR") ?? "?"}건) · 사업자번호 조회 불가`,
      });
    } else {
      results.set("revenue", { ok: false, empty: true, reason: "응답 없음" });
    }
  } catch (error) {
    results.set("revenue", { ok: false, reason: connectorErrorReason(error) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NICE BizAPI(OpenGate) 커넥터(dev 전용, 무계약 데모앱). 법인만 실행.
// OCOV06 재무 → revenue · financial_health.*, OCCD03 → 신용/납세 결격, OCCD06 → 법정관리/워크아웃.
// OCCD01(당좌정지)은 테스트앱 미프로비저닝(403) → bond_default 는 skip(pending). 모든 live 값에
// "NICE 데모앱(무계약)" 표식을 실어 화면에서 데모임을 드러낸다.
// 주의: OCOV06 는 FSC 기업재무와 같은 revenue·financial_health.* 키를 채운다(둘 다 corporation 에서
// 실행). FSC 는 법인등록번호 브리지가 있을 때만 값을 채우고 없으면 skip 하므로, 팝빌 경로(브리지 없음)
// 에서는 NICE 가 채운다. 브리지가 있으면 두 커넥터가 같은 키에 경합할 수 있다(Promise.all 완료 순서 의존).
// ─────────────────────────────────────────────────────────────────────────────

const NICE_DEMO_NOTE = "NICE 데모앱(무계약)";

const NICE_INDICATOR_FIELD_KEYS = [
  "revenue",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
] as const;

const NICE_NEGATIVE_FIELD_KEYS = [
  "credit_status.credit_delinquency",
  "credit_status.loan_default",
  "credit_status.financial_misconduct",
  "tax_compliance.national_tax_delinquent",
  "tax_compliance.local_tax_delinquent",
] as const;

const NICE_WORKOUT_FIELD_KEYS = [
  "credit_status.rehabilitation_in_progress",
  "credit_status.court_receivership",
] as const;

/**
 * NICE BizAPI 커넥터. subject=corporation 일 때만 실행(개인은 결과 없음 → pending/n-a 유지).
 * fail-open: 최후 try/catch 로 절대 throw 하지 않는다. 키(APP_KEY/SECRET) 둘 다 없으면 무결과 return.
 */
async function runNiceConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  try {
    if (input.subject !== "corporation") return; // 법인 전용(재무/신용 결격은 corpOnly)
    const appKey = process.env.NICE_BIZ_CLIENT_APP_KEY?.trim();
    const secret = process.env.NICE_BIZ_CLIENT_SECRET?.trim();
    if (!appKey || !secret) return; // 키 없음 → pending 유지
    const companyKey = input.bizNo.replace(/\D/g, "");

    // OCOV06 재무(독립 try) → revenue · financial_health.*
    try {
      const indicator = await checkNiceCorpIndicator({ appKey, secret, companyKey });
      setNiceIndicatorFields(results, indicator);
    } catch (error) {
      const failed: ConnectorResult = { ok: false, reason: connectorErrorReason(error) };
      for (const key of NICE_INDICATOR_FIELD_KEYS) results.set(key, failed);
    }

    // OCCD03/06/01 신용(오케스트레이터가 내부 guard, throw 안 함) → 신용/납세 결격
    const credit = await checkNiceCorpCredit({ appKey, secret, companyKey });
    setNiceCreditFields(results, credit);

    // OCCD01 당좌정지 미프로비저닝 → bond_default 는 skip(pending 유지).
    results.set("credit_status.bond_default", {
      ok: false,
      skipped: true,
      reason: "OCCD01 당좌정지 미프로비저닝(테스트앱)",
    });
    // 파산은 OCCD06 법정관리와 별개축 · 공공정보(OCCD03 PB)로도 재확인 필요 → 미매핑(pending).
    results.set("credit_status.bankruptcy_filed", {
      ok: false,
      skipped: true,
      reason: "파산은 OCCD06 법정관리와 별개 · 공공정보(OCCD03 PB) 재확인 필요",
    });
  } catch {
    // 최후 안전망 — 절대 throw 금지(runExternalConnectors Promise.all 보호).
  }
}

/** OCOV06 요약을 revenue · financial_health.* 로 매핑(금액은 압축 표기, 연도태그·데모표식 부착). */
function setNiceIndicatorFields(
  results: Map<string, ConnectorResult>,
  summary: Awaited<ReturnType<typeof checkNiceCorpIndicator>>,
): void {
  if (!summary) {
    const empty: ConnectorResult = { ok: false, empty: true, reason: "NICE 재무 데이터 없음" };
    for (const key of NICE_INDICATOR_FIELD_KEYS) results.set(key, empty);
    return;
  }
  const yearTag = summary.bizYear ? ` (${summary.bizYear})` : "";
  setNiceNumericField(results, "revenue", formatKrwCompact(summary.revenueWon), yearTag);
  setNiceNumericField(
    results,
    "financial_health.total_assets_krw",
    formatKrwCompact(summary.totalAssetsWon),
    yearTag,
  );
  setNiceNumericField(
    results,
    "financial_health.equity_krw",
    formatKrwCompact(summary.totalEquityWon),
    yearTag,
  );
  setNiceNumericField(
    results,
    "financial_health.debt_ratio_pct",
    summary.debtRatioPct !== null ? `${summary.debtRatioPct.toLocaleString("ko-KR")}%` : null,
    yearTag,
  );
  results.set("financial_health.impairment", {
    ok: true,
    value: `${summary.impaired ? "자본잠식" : "정상"}${yearTag}`,
    confidence: 0.75,
    source: "nice",
    note: NICE_DEMO_NOTE,
  });
}

/** OCOV06 수치 필드: 값 있으면 live(nice, 0.75, 데모표식), 없으면 empty(failed). */
function setNiceNumericField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  yearTag: string,
): void {
  if (value === null) {
    results.set(key, { ok: false, empty: true, reason: "값 미제공" });
    return;
  }
  results.set(key, {
    ok: true,
    value: `${value}${yearTag}`,
    confidence: 0.75,
    source: "nice",
    note: NICE_DEMO_NOTE,
  });
}

/** OCCD03(신용/납세 결격) · OCCD06(법정관리/워크아웃) 결과를 필드 키로 매핑. */
function setNiceCreditFields(
  results: Map<string, ConnectorResult>,
  credit: Awaited<ReturnType<typeof checkNiceCorpCredit>>,
): void {
  // OCCD03 신용도판단정보 → 신용/납세 결격.
  const neg = credit.negative;
  if (!neg.ok || !neg.data) {
    const failed: ConnectorResult = { ok: false, reason: neg.error ?? "OCCD03 조회 실패" };
    for (const key of NICE_NEGATIVE_FIELD_KEYS) results.set(key, failed);
  } else {
    const c = neg.data.counts;
    const live = (value: string): ConnectorResult => ({
      ok: true,
      value,
      confidence: 0.7,
      source: "nice",
      note: NICE_DEMO_NOTE,
    });
    // 채무불이행(BB) — credit_delinquency 와 loan_default 동일신호(대지급/대위변제 포함).
    const bbValue = c.bb > 0 ? `채무불이행 ${c.bb}건` : "해당없음";
    results.set("credit_status.credit_delinquency", live(bbValue));
    results.set("credit_status.loan_default", live(bbValue));
    // 금융질서문란(FD).
    results.set(
      "credit_status.financial_misconduct",
      live(c.fd > 0 ? `금융질서문란 ${c.fd}건` : "해당없음"),
    );
    // 공공정보(PB) — 국세/지방세 미분리 집계라 두 결격에 동일 신호 + 미분리 note.
    const pbValue = c.pb > 0 ? `공공정보 ${c.pb}건(국세/지방세 미분리)` : "해당없음";
    results.set("tax_compliance.national_tax_delinquent", live(pbValue));
    results.set("tax_compliance.local_tax_delinquent", live(pbValue));
  }

  // OCCD06 법정관리/워크아웃 → rehabilitation_in_progress · court_receivership 동일 신호.
  const wk = credit.workout;
  if (!wk.ok || !wk.data) {
    const failed: ConnectorResult = { ok: false, reason: wk.error ?? "OCCD06 조회 실패" };
    for (const key of NICE_WORKOUT_FIELD_KEYS) results.set(key, failed);
  } else {
    const n = wk.data.count;
    const value = n > 0 ? `법정관리/워크아웃 ${n}건` : "해당없음";
    for (const key of NICE_WORKOUT_FIELD_KEYS) {
      results.set(key, { ok: true, value, confidence: 0.7, source: "nice", note: NICE_DEMO_NOTE });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CODEF 간편인증 캐시 커넥터(dev 전용). 라이브 호출이 아니라 company_enrichment_cache 의
// provider="codef" 행(corporate-registration·vat-base·identity)을 판독한다 — CODEF 는 사용자
// 휴대폰 승인이 선행돼야 하므로 조회 경로에서 능동 호출하지 않는다(passive read). 인증은
// api/dev/codef/* 오케스트레이터가 처리하고 결과를 캐시에 남긴다. 국세청 확정값이라
// buildFieldCoverage 에서 최우선(codef > popbill/apick > derived/자가신고).
// fail-open: 어떤 예외도 밖으로 던지지 않는다(runExternalConnectors Promise.all 보호).
// ─────────────────────────────────────────────────────────────────────────────

const CODEF_CACHE_NOTE = "간편인증 캐시(국세청 확정값)";

/** identity scope canonicalPayload(오케스트레이터 finalizeDone 이 남긴 파생값 · 생년월일 원본 없음). */
interface CodefIdentityCache {
  founder_age?: number | null;
  gender?: "M" | "F" | null;
}

/**
 * company_enrichment_cache 의 provider="codef" 3 scope 를 판독해 국세청 확정 7축을 채운다.
 * 캐시 행이 하나도 없으면(=인증 전) 아무 결과도 넣지 않아 pending 을 유지한다.
 * 값이 없는 축은 스킵해 다른 커넥터/pending 을 침범하지 않는다.
 */
async function runCodefConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  try {
    const rows = await getServiceRepositories().enrichmentCache.listByBizNo(bizNo);
    const byScope = new Map<string, EnrichmentCacheEntry>();
    for (const row of rows) {
      if (row.provider === "codef") byScope.set(row.scope, row);
    }
    const corpRow = byScope.get("corporate-registration");
    const vatRow = byScope.get("vat-base");
    const identityRow = byScope.get("identity");
    if (!corpRow && !vatRow && !identityRow) return; // 인증 전 → pending 유지

    const corpFacts = (corpRow?.canonicalPayload ?? null) as CorporateRegistrationFacts | null;
    const vatFacts = (vatRow?.canonicalPayload ?? null) as VatBaseFacts | null;
    const identity = (identityRow?.canonicalPayload ?? null) as CodefIdentityCache | null;

    // 생년월일 원본은 저장하지 않으므로 birthDate8 없이 파생한다(founder_age 는 identity 캐시 사용).
    const { profile } = buildCompanyProfileFromCodef({
      corporateRegistration: corpFacts,
      vatBase: vatFacts,
      gender: identity?.gender ?? null,
    });

    setCodefField(results, "region", profile.region?.label ?? null, 0.95);
    setCodefField(results, "biz_age", formatBizAgeMonths(profile.biz_age_months ?? null), 0.95);
    setCodefField(
      results,
      "industry",
      profile.industries?.length ? profile.industries.join(", ") : null,
      0.95,
    );
    setCodefField(results, "target_type", profile.target_types?.[0] ?? null, 0.95);
    // 매출은 부가세 신고분(profile.revenue_krw)이 있을 때만.
    setCodefField(results, "revenue", formatKrwCompact(profile.revenue_krw ?? null), 0.95);
    // 대표자 연령은 identity 캐시의 founder_age(생년월일 파생 정수)만.
    const founderAge = typeof identity?.founder_age === "number" ? identity.founder_age : null;
    setCodefField(results, "founder_age", founderAge !== null ? `${founderAge}세` : null, 0.9);
    // 대표자 특성은 identity 캐시의 gender(여성/남성).
    const traitLabel = identity?.gender === "F" ? "여성" : identity?.gender === "M" ? "남성" : null;
    setCodefField(results, "founder_trait", traitLabel, 0.9);
  } catch {
    // fail-open — 캐시 판독 실패는 무시(pending 유지, 다른 커넥터 보호).
  }
}

/** 값이 있으면 codef live 결과로 세팅, 없으면 스킵(다른 소스/pending 유지). */
function setCodefField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  confidence: number,
): void {
  if (!value) return;
  results.set(key, { ok: true, value, confidence, source: "codef", note: CODEF_CACHE_NOTE });
}

/** biz_age_months 를 "N년 M개월" 로 표기(0개월·null 방어). */
function formatBizAgeMonths(months: number | null): string | null {
  if (months === null || !Number.isFinite(months) || months < 0) return null;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years > 0 && rem > 0) return `${years}년 ${rem}개월`;
  if (years > 0) return `${years}년`;
  return `${rem}개월`;
}

const DISQUALIFICATION_AXIS_LABELS: Record<DisqualificationAxis, string> = {
  tax_compliance: "납세 결격",
  credit_status: "신용 결격",
  sanction: "제재·명단 결격",
};

const DISQUALIFICATION_AXIS_ORDER: readonly DisqualificationAxis[] = [
  "tax_compliance",
  "credit_status",
  "sanction",
];

/**
 * canonical 사전에서 자가신고 Q&A 스키마를 만든다(서버 전용 · 직렬화 가능).
 * page.tsx(서버 컴포넌트)가 호출해 클라이언트에 props 로 넘긴다.
 */
export function buildQnaSchema(): QnaSchema {
  const byAxis = new Map<DisqualificationAxis, QnaQuestionSchema[]>();
  for (const question of DISQUALIFICATION_QUESTIONS) {
    const flags: QnaFlagSchema[] = question.covers.map((flag) => ({
      flag,
      label: DISQUALIFICATION_FLAG_LABELS[flag],
    }));
    const list = byAxis.get(question.axis) ?? [];
    list.push({ id: question.id, label: question.label, flags });
    byAxis.set(question.axis, list);
  }
  const disqualification: QnaAxisSchema[] = DISQUALIFICATION_AXIS_ORDER.map((axis) => ({
    axis,
    label: DISQUALIFICATION_AXIS_LABELS[axis],
    questions: byAxis.get(axis) ?? [],
  }));
  const exceptions: QnaExceptionSchema[] = DISQUALIFICATION_EXCEPTIONS.map((key) => ({
    key,
    label: DISQUALIFICATION_EXCEPTION_LABELS[key],
  }));
  return { disqualification, exceptions };
}
