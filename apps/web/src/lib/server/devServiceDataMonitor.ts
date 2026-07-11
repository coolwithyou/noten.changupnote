import { maskCorpNum } from "@cunote/core";
import type { EnrichmentCacheEntry, NtsBusinessStatusData, SmppCertificates } from "@cunote/core";
import { sanitizeCorpNum } from "@cunote/core/popbill/check-biz-info";
import type { CompanyEvidence, CompanyProfile, CriterionDimension } from "@cunote/contracts";
import {
  APICK_BIZ_DETAIL,
  APICK_BIZ_DETAIL_GUARD,
  loadApickBizDetailCompanyProfile,
} from "./apickBizDetail";
import {
  applySmppCertificatesToProfile,
  getServiceRepositories,
  loadCompanyProfileFromSourceWithEvidence,
  ntsClosedLabel,
  ServiceDataError,
} from "./serviceData";

// ─────────────────────────────────────────────────────────────────────────────
// 개발 전용 사업자 데이터 모니터. 실제 조회 파이프라인(팝빌·국세청·공공구매종합정보망)을
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

export interface ServiceDataLookupResult {
  bizNo: string;
  maskedBizNo: string;
  profile: CompanyProfile | null;
  evidence: CompanyEvidence | null;
  fields: ServiceDataField[];
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

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    profile,
    evidence,
    fields,
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

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    profile,
    evidence,
    fields,
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
