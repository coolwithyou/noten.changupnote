import { createHash } from "node:crypto";
import type { CompanyEnrichmentFacts, CompanyEvidence, CompanyProfile, CriterionDimension } from "@cunote/contracts";
import type { EnrichmentCacheEntry, EnrichmentCacheRepository } from "@cunote/core";
import {
  calculateBizAgeMonths,
  expandKsicCodes,
  isLikelyKsicCode,
  normalizeCompanyIndustryProfile,
  resolveRegionFromAddress,
} from "@cunote/core/company/profile-from-popbill";
import { maskCorpNum, sanitizeCorpNum } from "@cunote/core/popbill/check-biz-info";
import { getRepositoryAdapterName } from "./repositories/factory";
import { buildCompanyEvidence, ServiceDataError } from "./serviceData";
import { loadMonorepoEnv } from "./loadMonorepoEnv";

export const APICK_BIZ_DETAIL = { provider: "apick", scope: "bizDetail" } as const;
export const APICK_BIZ_DETAIL_GUARD = { provider: "apick", scope: "bizDetailGuard" } as const;

const APICK_BIZ_DETAIL_URL = "https://apick.app/rest/biz_detail";
const APICK_TIMEOUT_MS = 20_000;
const APICK_CACHE_TTL_HOURS_ENV = "APICK_BIZ_DETAIL_CACHE_TTL_HOURS";
const APICK_MAX_LIVE_LOOKUPS_ENV = "APICK_MAX_LIVE_LOOKUPS_PER_BIZ";

export interface ApickBizDetailResolution {
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
  evidence: CompanyEvidence;
}

interface ApickBizDetailPayload {
  data?: Record<string, unknown> | null;
  api?: {
    success?: boolean | null;
    cost?: number | null;
    ms?: number | null;
    pl_id?: number | string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export async function loadApickBizDetailCompanyProfile(input: {
  bizNo: string;
  cache: EnrichmentCacheRepository;
  asOf?: Date;
  now?: Date;
  forceRefresh?: boolean;
}): Promise<ApickBizDetailResolution> {
  const bizNo = sanitizeCorpNum(input.bizNo);
  const now = input.now ?? new Date();
  const asOf = input.asOf ?? now;

  if (process.env.NODE_ENV !== "production") loadMonorepoEnv();

  if (getRepositoryAdapterName() !== "drizzle") {
    throw new ServiceDataError(
      "apick_cache_unavailable",
      "Apick 조회는 테스트 계정 호출 수 보호를 위해 DB 캐시가 구성된 상태에서만 실행할 수 있습니다.",
      503,
      "bizNo",
    );
  }

  const cached = await readCachedApick(input.cache, bizNo, now);
  if (cached && !input.forceRefresh) {
    return cachedResolution(cached, "Apick 캐시를 재사용해 회사 정보를 확인했습니다.");
  }

  const guard = await input.cache.getFresh({
    provider: APICK_BIZ_DETAIL_GUARD.provider,
    bizNo,
    scope: APICK_BIZ_DETAIL_GUARD.scope,
    now,
  }).catch(() => null);
  const liveLookupCount = readLiveLookupCount(guard);
  const maxLiveLookups = readMaxLiveLookups();
  if (liveLookupCount >= maxLiveLookups) {
    if (cached) {
      return cachedResolution(
        cached,
        `Apick 테스트 계정 보호를 위해 라이브 재조회 대신 캐시를 재사용했습니다. (${liveLookupCount}/${maxLiveLookups})`,
      );
    }
    throw new ServiceDataError(
      "apick_live_lookup_limited",
      `Apick 라이브 조회 한도에 도달했습니다. 사업자번호별 최대 ${maxLiveLookups}회까지만 허용합니다.`,
      429,
      "bizNo",
    );
  }

  const config = readApickBizDetailEnv();
  const payload = await fetchApickBizDetail({
    url: config.url,
    apiKey: config.apiKey,
    bizNo,
    timeoutMs: config.timeoutMs,
  });
  const data = isRecord(payload.data) ? payload.data : {};
  const built = buildCompanyProfileFromApick(data, {
    asOf,
    checkedAt: now,
    api: isRecord(payload.api) ? payload.api : null,
  });
  const canonicalPayload = {
    profile: built.profile,
    facts: built.facts,
    api: payload.api ?? null,
  };
  const checkedAt = now;
  const expiresAt = resolveApickCacheExpiresAt(now);

  const saved = await input.cache.put({
    provider: APICK_BIZ_DETAIL.provider,
    bizNo,
    scope: APICK_BIZ_DETAIL.scope,
    rawPayload: payload as Record<string, unknown>,
    canonicalPayload,
    providerResultCode: String(data.success ?? payload.api?.success ?? "unknown"),
    providerResultMessage: built.facts.resultMessage,
    checkedAt,
    fetchedAt: now,
    expiresAt,
    payloadHash: hashPayload(canonicalPayload),
  });

  await input.cache.put({
    provider: APICK_BIZ_DETAIL_GUARD.provider,
    bizNo,
    scope: APICK_BIZ_DETAIL_GUARD.scope,
    rawPayload: null,
    canonicalPayload: {
      liveLookupCount: liveLookupCount + 1,
      maxLiveLookups,
      lastLiveLookupAt: now.toISOString(),
    },
    providerResultCode: String(liveLookupCount + 1),
    providerResultMessage: `Apick live lookup ${liveLookupCount + 1}/${maxLiveLookups}`,
    checkedAt,
    fetchedAt: now,
    expiresAt: null,
    payloadHash: hashPayload({ bizNo, liveLookupCount: liveLookupCount + 1, maxLiveLookups }),
  });

  return cachedResolution(saved, "Apick에서 사업자 정보를 확인했고 이후 조회는 캐시를 기본 재사용합니다.", "stored");
}

function readApickBizDetailEnv(): { apiKey: string; url: string; timeoutMs: number } {
  if (process.env.NODE_ENV !== "production") loadMonorepoEnv();
  const apiKey = readOptionalEnv("APICK_API_KEY", "APICK_AUTH_KEY", "CL_AUTH_KEY");
  if (!apiKey) {
    throw new ServiceDataError("apick_env_missing", "APICK_API_KEY가 설정되어 있지 않습니다.", 503);
  }
  const url = readOptionalEnv("APICK_BIZ_DETAIL_URL") ?? APICK_BIZ_DETAIL_URL;
  const timeoutMs = readPositiveIntegerEnv("APICK_TIMEOUT_MS") ?? APICK_TIMEOUT_MS;
  return { apiKey, url, timeoutMs };
}

async function fetchApickBizDetail(input: {
  url: string;
  apiKey: string;
  bizNo: string;
  timeoutMs: number;
}): Promise<ApickBizDetailPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const form = new FormData();
    form.set("biz_no", input.bizNo);
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        CL_AUTH_KEY: input.apiKey,
      },
      body: form,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ServiceDataError(
        "apick_lookup_failed",
        `Apick 사업자 조회가 실패했습니다. HTTP ${response.status}`,
        502,
        "bizNo",
      );
    }
    if (!isRecord(body)) {
      throw new ServiceDataError("apick_invalid_response", "Apick 응답 형식이 올바르지 않습니다.", 502, "bizNo");
    }
    const payload = body as ApickBizDetailPayload;
    if (payload.api && payload.api.success === false) {
      throw new ServiceDataError("apick_lookup_failed", "Apick API가 실패 응답을 반환했습니다.", 502, "bizNo");
    }
    return payload;
  } catch (error) {
    if (error instanceof ServiceDataError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ServiceDataError("apick_lookup_timeout", "Apick 응답 시간이 초과되었습니다.", 504, "bizNo");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildCompanyProfileFromApick(
  data: Record<string, unknown>,
  options: { asOf: Date; checkedAt: Date; api: Record<string, unknown> | null },
): { profile: CompanyProfile; facts: CompanyEnrichmentFacts } {
  const bizNo = firstText(data["사업자등록번호"], data["사업자번호"]);
  const companyName = firstText(data["회사명"], data["등록기업명"], data["기업명"], data["통판_법인명"]);
  const roadAddress = firstText(data["도로명주소"], data["통판_도로명주소"]);
  const lotAddress = firstText(data["지번주소"], data["통판_소재지주소"]);
  const region = resolveRegionFromAddress(roadAddress ?? lotAddress);
  const establishedAt = firstText(data["설립일"], data["설립일(원본)"], data["최초등록일"]);
  const bizAgeMonths = calculateBizAgeMonths(establishedAt, options.asOf);
  const industries = normalizeIndustryLabels([
    data["업종"],
    data["업태"],
    data["종목"],
    data["산업분류명(10차)"],
    data["산업분류명(9차)"],
  ]);
  const industryCodes = uniqueTexts([
    ...expandKsicCodes(firstText(data["표준산업분류(노동부) 업종코드"])),
    ...expandKsicCodes(firstText(data["산업분류코드(10차)"])),
    ...expandKsicCodes(firstText(data["산업분류코드(9차)"])),
  ]);
  const employees = integerValue(data["직원수"]);
  const statusCode = firstText(data["사업자상태코드"]);
  const statusLabel = firstText(data["사업자상태"], data["기업상태"]);
  const taxTypeCode = firstText(data["과세유형코드"]);
  const active = statusCode ? statusCode === "01" : statusLabel ? /계속|정상/.test(statusLabel) : undefined;
  const confidence: Partial<Record<CriterionDimension, number>> = {};
  if (region) confidence.region = 0.85;
  if (bizAgeMonths !== null) confidence.biz_age = 0.85;
  if (industries.length || industryCodes.length) confidence.industry = industryCodes.length ? 0.85 : 0.75;
  if (typeof employees === "number") confidence.employees = 0.65;
  if (statusCode || statusLabel || taxTypeCode) confidence.business_status = 0.9;

  const profile: CompanyProfile = {
    is_preliminary: false,
    industries,
    confidence,
    other_conditions: compactRecord({
      apick_corporate_registration_no: firstText(data["법인등록번호"], data["법인등록번호_공정위"]),
      apick_commerce_registration_no: firstText(data["통신판매업번호"], data["통판_인허가번호"]),
      apick_ceo_name: firstText(data["대표명"], data["대표자명"], data["통판_대표자명"]),
      apick_tax_type: firstText(data["과세유형"]),
      apick_tax_type_code: taxTypeCode,
      apick_road_address: roadAddress,
      apick_lot_address: lotAddress,
      apick_zip_code: firstText(data["우편번호"]),
      apick_latitude: firstText(data["위도"]),
      apick_longitude: firstText(data["경도"]),
      apick_updated_at: firstText(data["갱신일"]),
      apick_first_registered_at: firstText(data["최초등록일"]),
      apick_established_at_raw: firstText(data["설립일(원본)"]),
      apick_company_type: firstText(data["기업유형"], data["기업형태"], data["통판_사업자구분"]),
      apick_credit_rating: firstText(data["신용등급"], data["신용등급(코드)"]),
      apick_api_ms: numberValue(options.api?.ms),
      apick_api_cost: numberValue(options.api?.cost),
      apick_api_pl_id: firstText(options.api?.pl_id),
    }),
  };
  if (bizNo) profile.id = `apick:${maskCorpNum(sanitizeCorpNum(bizNo))}`;
  if (companyName) profile.name = companyName;
  if (region) profile.region = region;
  if (bizAgeMonths !== null) profile.biz_age_months = bizAgeMonths;
  if (industryCodes.length > 0) profile.industry_codes = industryCodes;
  if (typeof employees === "number") profile.employees_count = employees;
  if (active !== undefined || statusLabel || taxTypeCode) {
    const businessStatus: NonNullable<CompanyProfile["business_status"]> = {
      ...(active !== undefined ? { active } : {}),
      close_down_state: statusCode ?? null,
      close_down_tax_type: taxTypeCode ?? null,
    };
    const resolvedStatusLabel = statusLabel ?? (active ? "계속사업자" : null);
    if (resolvedStatusLabel) businessStatus.label = resolvedStatusLabel;
    profile.business_status = businessStatus;
  }

  const normalized = normalizeCompanyIndustryProfile(profile);
  return {
    profile: normalized,
    facts: {
      maskedBizNo: bizNo ? maskCorpNum(sanitizeCorpNum(bizNo)) : null,
      result: firstText(data.success) ?? (options.api?.success === true ? 1 : null),
      resultMessage: options.api?.success === false ? "실패" : "성공",
      checkedAt: options.checkedAt.toISOString(),
      hasCorpName: Boolean(companyName),
      hasRegion: Boolean(region),
      hasBizAge: bizAgeMonths !== null,
      hasSize: Boolean(normalized.size),
      hasIndustry: Boolean(normalized.industries?.length || normalized.industry_codes?.length),
      closeDownState: statusCode ?? null,
      closeDownTaxType: taxTypeCode ?? null,
    },
  };
}

async function readCachedApick(
  cache: EnrichmentCacheRepository,
  bizNo: string,
  now: Date,
): Promise<EnrichmentCacheEntry | null> {
  return cache.getFresh({
    provider: APICK_BIZ_DETAIL.provider,
    bizNo,
    scope: APICK_BIZ_DETAIL.scope,
    now,
  });
}

function cachedResolution(
  entry: EnrichmentCacheEntry,
  summary: string,
  cacheStatus: CompanyEvidence["cacheStatus"] = "hit",
): ApickBizDetailResolution {
  const parsed = parseCachedApick(entry.canonicalPayload);
  if (!parsed) {
    throw new ServiceDataError("apick_cache_invalid", "Apick 캐시 형식이 올바르지 않습니다.", 500, "bizNo");
  }
  return {
    ...parsed,
    evidence: buildCompanyEvidence(compactEvidenceInput({
      provider: "apick",
      source: cacheStatus === "hit" ? "apick_cache" : "apick_live",
      cacheStatus,
      profile: parsed.profile,
      facts: parsed.facts,
      checkedAt: entry.checkedAt ?? null,
      cachedUntil: entry.expiresAt ?? null,
      summary,
    })),
  };
}

function compactEvidenceInput(input: {
  provider: CompanyEvidence["provider"];
  source: CompanyEvidence["source"];
  cacheStatus: CompanyEvidence["cacheStatus"];
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
  checkedAt?: Date | null;
  cachedUntil?: Date | null;
  summary: string;
}) {
  return {
    provider: input.provider,
    source: input.source,
    cacheStatus: input.cacheStatus,
    profile: input.profile,
    facts: input.facts,
    ...(input.checkedAt !== undefined ? { checkedAt: input.checkedAt } : {}),
    ...(input.cachedUntil !== undefined ? { cachedUntil: input.cachedUntil } : {}),
    summary: input.summary,
  };
}

function parseCachedApick(
  payload: Record<string, unknown> | null | undefined,
): { profile: CompanyProfile; facts: CompanyEnrichmentFacts } | null {
  if (!isRecord(payload) || !isRecord(payload.profile) || !isRecord(payload.facts)) return null;
  const facts = parseFacts(payload.facts);
  if (!facts) return null;
  return {
    profile: normalizeCompanyIndustryProfile(payload.profile as CompanyProfile),
    facts,
  };
}

function parseFacts(input: Record<string, unknown>): CompanyEnrichmentFacts | null {
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
    maskedBizNo: nullableString(input.maskedBizNo),
    result: nullableStringOrNumber(input.result),
    resultMessage: nullableString(input.resultMessage),
    checkedAt: nullableString(input.checkedAt),
    hasCorpName,
    hasRegion,
    hasBizAge,
    hasSize,
    hasIndustry,
    closeDownState: nullableStringOrNumber(input.closeDownState),
    closeDownTaxType: nullableStringOrNumber(input.closeDownTaxType),
  };
}

function readLiveLookupCount(entry: EnrichmentCacheEntry | null): number {
  const payload = entry?.canonicalPayload;
  if (!isRecord(payload)) return 0;
  const count = numberValue(payload.liveLookupCount);
  return count && count > 0 ? Math.floor(count) : 0;
}

function readMaxLiveLookups(): number {
  const value = readPositiveIntegerEnv(APICK_MAX_LIVE_LOOKUPS_ENV);
  return value && value > 0 ? value : 2;
}

function resolveApickCacheExpiresAt(now: Date): Date | null {
  const ttlHours = readPositiveIntegerEnv(APICK_CACHE_TTL_HOURS_ENV);
  if (!ttlHours) return null;
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

function readOptionalEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function readPositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeIndustryLabels(values: unknown[]): string[] {
  return uniqueTexts(values.flatMap((value) => splitText(value)))
    .filter((value) => !isLikelyKsicCode(value));
}

function splitText(value: unknown): string[] {
  const text = firstText(value);
  if (!text) return [];
  return text
    .split(/[\/,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> | null {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

function integerValue(value: unknown): number | null {
  const number = numberValue(value);
  return number === null ? null : Math.floor(number);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableStringOrNumber(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function uniqueTexts(values: string[]): string[] {
  return [...new Set(values)];
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
