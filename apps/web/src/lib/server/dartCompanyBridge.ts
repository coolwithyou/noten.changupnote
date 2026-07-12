import {
  checkDartCompanyOverview,
  findDartCorpCodeCandidates,
  parseDartCorpCodes,
  type DartCompanyOverview,
  type DartCorpCodeEntry,
  type EnrichmentCacheRepository,
} from "@cunote/core";
import { strFromU8, unzipSync } from "fflate";

const DART_CORP_CODE_ENDPOINT = "https://opendart.fss.or.kr/api/corpCode.xml";
const DART_BRIDGE_CACHE = { provider: "opendart", scope: "company-bridge" } as const;
const DART_BRIDGE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DART_CORP_CODE_MEMORY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface DartCompanyBridge {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
  corpClass: string | null;
  businessRegistrationNumber: string;
  corporateRegistrationNumber: string;
  establishedOn: string | null;
  industryCode: string | null;
}

export interface DartCompanyBridgeLookup {
  state: "covered" | "not_covered";
  bridge: DartCompanyBridge | null;
  reason: string;
  asOf: string;
  origin: "live" | "cache";
}

interface CorpCodeMemoryCache {
  entries: DartCorpCodeEntry[];
  expiresAt: number;
}

let corpCodeMemoryCache: CorpCodeMemoryCache | null = null;
let inflightCorpCodeLoad: Promise<DartCorpCodeEntry[]> | null = null;
const inflightBridgeLookups = new Map<string, Promise<DartCompanyBridgeLookup>>();

export async function resolveDartCompanyBridge(input: {
  apiKey: string;
  bizNo: string;
  companyName: string;
  cache: EnrichmentCacheRepository;
  now?: Date;
}): Promise<DartCompanyBridgeLookup> {
  const apiKey = input.apiKey.trim();
  const bizNo = input.bizNo.replace(/\D/g, "");
  const companyName = input.companyName.trim();
  const now = input.now ?? new Date();
  if (!apiKey) throw new Error("OpenDART API 키가 없습니다.");
  if (bizNo.length !== 10) throw new Error("OpenDART 브리지 사업자번호는 10자리여야 합니다.");
  if (!companyName) {
    return {
      state: "not_covered",
      bridge: null,
      reason: "회사명 없음 · OpenDART 후보 검색 불가",
      asOf: now.toISOString(),
      origin: "live",
    };
  }

  const cached = await input.cache.getFresh({
    provider: DART_BRIDGE_CACHE.provider,
    bizNo,
    scope: DART_BRIDGE_CACHE.scope,
    now,
  }).catch(() => null);
  const cachedLookup = readBridgeCache(cached?.canonicalPayload);
  if (cached && cachedLookup) {
    return {
      ...cachedLookup,
      asOf: cached.checkedAt?.toISOString() ?? cached.fetchedAt.toISOString(),
      origin: "cache",
    };
  }

  const existing = inflightBridgeLookups.get(bizNo);
  if (existing) return existing;
  const task = resolveDartCompanyBridgeLive({ apiKey, bizNo, companyName, now })
    .then(async (lookup) => {
      await input.cache.put({
        provider: DART_BRIDGE_CACHE.provider,
        bizNo,
        scope: DART_BRIDGE_CACHE.scope,
        canonicalPayload: lookup as unknown as Record<string, unknown>,
        providerResultCode: lookup.state === "covered" ? "000" : "013",
        providerResultMessage: lookup.reason,
        checkedAt: now,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + DART_BRIDGE_TTL_MS),
      }).catch(() => null);
      return lookup;
    })
    .finally(() => {
      if (inflightBridgeLookups.get(bizNo) === task) inflightBridgeLookups.delete(bizNo);
    });
  inflightBridgeLookups.set(bizNo, task);
  return task;
}

async function resolveDartCompanyBridgeLive(input: {
  apiKey: string;
  bizNo: string;
  companyName: string;
  now: Date;
}): Promise<DartCompanyBridgeLookup> {
  const entries = await loadDartCorpCodes(input.apiKey);
  const candidates = findDartCorpCodeCandidates(entries, input.companyName, 10);
  if (candidates.length === 0) return notCovered("OpenDART 회사코드 exact 회사명 후보 없음", input.now);

  const overviews = await Promise.all(
    candidates.map((candidate) => checkDartCompanyOverview({ apiKey: input.apiKey, corpCode: candidate.corpCode })),
  );
  const exact = overviews.find(
    (overview): overview is DartCompanyOverview =>
      overview !== null && overview.businessRegistrationNumber === input.bizNo,
  );
  if (!exact) return notCovered("OpenDART 회사개황 사업자번호 exact 불일치", input.now);
  if (!exact.corporateRegistrationNumber) {
    return notCovered("OpenDART 대상이지만 법인등록번호 미제공", input.now);
  }
  return {
    state: "covered",
    bridge: {
      corpCode: exact.corpCode,
      corpName: exact.corpName,
      stockCode: exact.stockCode,
      corpClass: exact.corpClass,
      businessRegistrationNumber: exact.businessRegistrationNumber,
      corporateRegistrationNumber: exact.corporateRegistrationNumber,
      establishedOn: exact.establishedOn,
      industryCode: exact.industryCode,
    },
    reason: "OpenDART 회사개황 bizr_no exact",
    asOf: input.now.toISOString(),
    origin: "live",
  };
}

export async function loadDartCorpCodes(apiKey: string): Promise<DartCorpCodeEntry[]> {
  const now = Date.now();
  if (corpCodeMemoryCache && corpCodeMemoryCache.expiresAt > now) return corpCodeMemoryCache.entries;
  if (inflightCorpCodeLoad) return inflightCorpCodeLoad;
  const task = fetchDartCorpCodes(apiKey).finally(() => {
    if (inflightCorpCodeLoad === task) inflightCorpCodeLoad = null;
  });
  inflightCorpCodeLoad = task;
  const entries = await task;
  corpCodeMemoryCache = { entries, expiresAt: now + DART_CORP_CODE_MEMORY_TTL_MS };
  return entries;
}

async function fetchDartCorpCodes(apiKey: string): Promise<DartCorpCodeEntry[]> {
  const url = new URL(DART_CORP_CODE_ENDPOINT);
  url.searchParams.set("crtfc_key", apiKey);
  const response = await fetch(url, { headers: { Accept: "application/zip, application/octet-stream" } });
  if (!response.ok) throw new Error(`OpenDART corpCode HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    const text = strFromU8(bytes).slice(0, 300);
    throw new Error(`OpenDART corpCode ZIP 해제 실패${text ? ` (${text})` : ""}`, { cause: error });
  }
  const xmlBytes = Object.entries(files).find(([name]) => /(^|\/)CORPCODE\.xml$/i.test(name))?.[1];
  if (!xmlBytes) throw new Error("OpenDART corpCode ZIP에 CORPCODE.xml이 없습니다.");
  const entries = parseDartCorpCodes(strFromU8(xmlBytes));
  if (entries.length === 0) throw new Error("OpenDART corpCode 목록이 비어 있습니다.");
  return entries;
}

function notCovered(reason: string, now: Date): DartCompanyBridgeLookup {
  return { state: "not_covered", bridge: null, reason, asOf: now.toISOString(), origin: "live" };
}

function readBridgeCache(value: Record<string, unknown> | null | undefined): DartCompanyBridgeLookup | null {
  if (!value || (value.state !== "covered" && value.state !== "not_covered")) return null;
  const reason = typeof value.reason === "string" ? value.reason : "OpenDART 캐시";
  const asOf = typeof value.asOf === "string" ? value.asOf : new Date(0).toISOString();
  if (value.state === "not_covered") {
    return { state: "not_covered", bridge: null, reason, asOf, origin: "cache" };
  }
  const raw = value.bridge;
  if (!raw || typeof raw !== "object") return null;
  const bridge = raw as Record<string, unknown>;
  if (
    typeof bridge.corpCode !== "string" ||
    typeof bridge.corpName !== "string" ||
    typeof bridge.businessRegistrationNumber !== "string" ||
    typeof bridge.corporateRegistrationNumber !== "string"
  ) return null;
  const stringOrNull = (input: unknown): string | null => typeof input === "string" ? input : null;
  return {
    state: "covered",
    bridge: {
      corpCode: bridge.corpCode,
      corpName: bridge.corpName,
      stockCode: stringOrNull(bridge.stockCode),
      corpClass: stringOrNull(bridge.corpClass),
      businessRegistrationNumber: bridge.businessRegistrationNumber,
      corporateRegistrationNumber: bridge.corporateRegistrationNumber,
      establishedOn: stringOrNull(bridge.establishedOn),
      industryCode: stringOrNull(bridge.industryCode),
    },
    reason,
    asOf,
    origin: "cache",
  };
}
