import {
  checkDartEmployeeStatus,
  checkDartFinancialAccounts,
  type DartEmployeeStatusSnapshot,
  type DartFinancialSnapshot,
  type DartReportCode,
  type EnrichmentCacheEntry,
  type EnrichmentCacheRepository,
} from "@cunote/core";
import type { DartCompanyBridge } from "./dartCompanyBridge";

const PROVIDER = "opendart";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const inflightLookups = new Map<string, Promise<DartOverlayLookup>>();

export interface DartOverlayLookup {
  businessYear: string;
  reportCode: DartReportCode;
  employee: DartEmployeeStatusSnapshot | null;
  employeeError: string | null;
  financials: DartFinancialSnapshot[];
  financialError: string | null;
  employeeOrigin: "live" | "cache";
  financialOrigin: "live" | "cache";
  origin: "live" | "cache" | "mixed";
}

export async function resolveLatestDartOverlay(input: {
  apiKey: string;
  bizNo: string;
  bridge: DartCompanyBridge;
  cache: EnrichmentCacheRepository;
  now?: Date;
  businessYear?: string;
  reportCode?: DartReportCode;
}): Promise<DartOverlayLookup> {
  const now = input.now ?? new Date();
  const businessYear = input.businessYear ?? String(seoulYear(now) - 1);
  const reportCode = input.reportCode ?? "11011";
  const key = `${input.bizNo}:${input.bridge.corpCode}:${businessYear}:${reportCode}`;
  const existing = inflightLookups.get(key);
  if (existing) return existing;
  const task = resolveDartOverlayScope({ ...input, now, businessYear, reportCode }).finally(() => {
    if (inflightLookups.get(key) === task) inflightLookups.delete(key);
  });
  inflightLookups.set(key, task);
  return task;
}

async function resolveDartOverlayScope(input: {
  apiKey: string;
  bizNo: string;
  bridge: DartCompanyBridge;
  cache: EnrichmentCacheRepository;
  now: Date;
  businessYear: string;
  reportCode: DartReportCode;
}): Promise<DartOverlayLookup> {
  const employeeScope = `employee:${input.businessYear}:${input.reportCode}`;
  const cfsScope = `finance:${input.businessYear}:${input.reportCode}:CFS`;
  const ofsScope = `finance:${input.businessYear}:${input.reportCode}:OFS`;
  const [employeeEntry, cfsEntry, ofsEntry] = await Promise.all([
    getFresh(input.cache, input.bizNo, employeeScope, input.now),
    getFresh(input.cache, input.bizNo, cfsScope, input.now),
    getFresh(input.cache, input.bizNo, ofsScope, input.now),
  ]);
  const employeeCached = readEmployeeEntry(employeeEntry);
  const cfsCached = readFinancialEntry(cfsEntry, "CFS");
  const ofsCached = readFinancialEntry(ofsEntry, "OFS");
  const needsEmployee = employeeCached === undefined;
  const needsFinancial = cfsCached === undefined || ofsCached === undefined;

  if (!needsEmployee && !needsFinancial) {
    return {
      businessYear: input.businessYear,
      reportCode: input.reportCode,
      employee: employeeCached,
      employeeError: null,
      financials: [cfsCached, ofsCached].filter((value): value is DartFinancialSnapshot => value !== null),
      financialError: null,
      employeeOrigin: "cache",
      financialOrigin: "cache",
      origin: "cache",
    };
  }

  const [employeeResult, financialResult] = await Promise.all([
    needsEmployee
      ? settle(() => checkDartEmployeeStatus({
          apiKey: input.apiKey,
          corpCode: input.bridge.corpCode,
          businessYear: input.businessYear,
          reportCode: input.reportCode,
        }))
      : Promise.resolve({ value: employeeCached, error: null }),
    needsFinancial
      ? settle(() => checkDartFinancialAccounts({
          apiKey: input.apiKey,
          corpCode: input.bridge.corpCode,
          businessYear: input.businessYear,
          reportCode: input.reportCode,
        }))
      : Promise.resolve({
          value: [cfsCached, ofsCached].filter((value): value is DartFinancialSnapshot => value !== null),
          error: null,
        }),
  ]);

  const writes: Promise<unknown>[] = [];
  if (needsEmployee && employeeResult.error === null) {
    writes.push(putSnapshot(input, employeeScope, employeeResult.value, employeeResult.value ? "000" : "013"));
  }
  if (needsFinancial && financialResult.error === null) {
    const financials = financialResult.value ?? [];
    const cfs = financials.find((snapshot) => snapshot.statementType === "CFS") ?? null;
    const ofs = financials.find((snapshot) => snapshot.statementType === "OFS") ?? null;
    writes.push(
      putSnapshot(input, cfsScope, cfs, cfs ? "000" : "013"),
      putSnapshot(input, ofsScope, ofs, ofs ? "000" : "013"),
    );
  }
  await Promise.all(writes);

  const financials = financialResult.error === null
    ? financialResult.value ?? []
    : [cfsCached, ofsCached].filter((value): value is DartFinancialSnapshot => value !== null);
  return {
    businessYear: input.businessYear,
    reportCode: input.reportCode,
    employee: employeeResult.error === null ? employeeResult.value ?? null : employeeCached ?? null,
    employeeError: employeeResult.error,
    financials,
    financialError: financialResult.error,
    employeeOrigin: needsEmployee ? "live" : "cache",
    financialOrigin: needsFinancial ? "live" : "cache",
    origin: needsEmployee && needsFinancial ? "live" : "mixed",
  };
}

async function settle<T>(work: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await work(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getFresh(
  cache: EnrichmentCacheRepository,
  bizNo: string,
  scope: string,
  now: Date,
): Promise<EnrichmentCacheEntry | null> {
  return cache.getFresh({ provider: PROVIDER, bizNo, scope, now }).catch(() => null);
}

async function putSnapshot(
  input: {
    bizNo: string;
    cache: EnrichmentCacheRepository;
    now: Date;
    businessYear: string;
    reportCode: DartReportCode;
  },
  scope: string,
  snapshot: DartEmployeeStatusSnapshot | DartFinancialSnapshot | null,
  resultCode: "000" | "013",
): Promise<unknown> {
  return input.cache.put({
    provider: PROVIDER,
    bizNo: input.bizNo,
    scope,
    canonicalPayload: { state: snapshot ? "value" : "empty", snapshot },
    providerResultCode: resultCode,
    providerResultMessage: snapshot
      ? `${input.businessYear} ${input.reportCode} snapshot`
      : `${input.businessYear} ${input.reportCode} no data`,
    checkedAt: input.now,
    fetchedAt: input.now,
    expiresAt: new Date(input.now.getTime() + CACHE_TTL_MS),
  }).catch(() => null);
}

function readEmployeeEntry(entry: EnrichmentCacheEntry | null): DartEmployeeStatusSnapshot | null | undefined {
  if (!entry) return undefined;
  const payload = entry.canonicalPayload;
  if (payload?.state === "empty") return null;
  const snapshot = payload?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const row = snapshot as Record<string, unknown>;
  if (typeof row.corpCode !== "string" || typeof row.businessYear !== "string" || typeof row.reportCode !== "string") {
    return undefined;
  }
  return snapshot as unknown as DartEmployeeStatusSnapshot;
}

function readFinancialEntry(
  entry: EnrichmentCacheEntry | null,
  statementType: "CFS" | "OFS",
): DartFinancialSnapshot | null | undefined {
  if (!entry) return undefined;
  const payload = entry.canonicalPayload;
  if (payload?.state === "empty") return null;
  const snapshot = payload?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const row = snapshot as Record<string, unknown>;
  if (
    typeof row.corpCode !== "string" ||
    typeof row.businessYear !== "string" ||
    row.statementType !== statementType
  ) return undefined;
  return snapshot as unknown as DartFinancialSnapshot;
}

function seoulYear(now: Date): number {
  return Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(now));
}
