/** OpenDART 단일회사 주요계정 API — 연결·별도 재무 스냅샷을 분리한다. */

import type { DartReportCode } from "./employee-status.js";

const DART_FINANCIAL_ENDPOINT = "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json";
const DEFAULT_TIMEOUT_MS = 6_000;

export type DartStatementType = "CFS" | "OFS";

export interface DartFinancialSnapshot {
  corpCode: string;
  businessYear: string;
  reportCode: DartReportCode;
  statementType: DartStatementType;
  statementName: string | null;
  receptionNo: string | null;
  periodEnd: string | null;
  revenue: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  currency: string | null;
}

export interface CheckDartFinancialAccountsInput {
  apiKey: string;
  corpCode: string;
  businessYear: string;
  reportCode?: DartReportCode;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DartFinancialAccountsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DartFinancialAccountsError";
  }
}

export async function checkDartFinancialAccounts(
  input: CheckDartFinancialAccountsInput,
): Promise<DartFinancialSnapshot[]> {
  const apiKey = input.apiKey.trim();
  const corpCode = input.corpCode.replace(/\D/g, "");
  const businessYear = input.businessYear.replace(/\D/g, "");
  const reportCode = input.reportCode ?? "11011";
  if (!apiKey) throw new DartFinancialAccountsError("OpenDART API 키가 없습니다.");
  if (corpCode.length !== 8) throw new DartFinancialAccountsError("OpenDART corp_code는 8자리여야 합니다.");
  if (businessYear.length !== 4) throw new DartFinancialAccountsError("OpenDART 사업연도는 4자리여야 합니다.");

  const url = new URL(DART_FINANCIAL_ENDPOINT);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", businessYear);
  url.searchParams.set("reprt_code", reportCode);
  const payload = await fetchDartJson(url, input.fetchImpl, input.timeoutMs);
  return parseDartFinancialAccounts(payload, { corpCode, businessYear, reportCode });
}

export function parseDartFinancialAccounts(
  payload: unknown,
  scope: { corpCode: string; businessYear: string; reportCode: DartReportCode },
): DartFinancialSnapshot[] {
  const root = record(payload, "OpenDART 주요계정 응답 형식 오류");
  const status = stringValue(root.status);
  if (status === "013") return [];
  if (status !== "000") {
    const message = stringValue(root.message);
    throw new DartFinancialAccountsError(`OpenDART 주요계정 status=${status ?? "unknown"}${message ? ` (${message})` : ""}`);
  }
  if (!Array.isArray(root.list)) throw new DartFinancialAccountsError("OpenDART 주요계정 list 누락");

  const rows = root.list.map((item) => record(item, "OpenDART 주요계정 행 형식 오류"));
  const snapshots: DartFinancialSnapshot[] = [];
  for (const statementType of ["CFS", "OFS"] as const) {
    const statementRows = rows.filter((row) => stringValue(row.fs_div) === statementType);
    if (statementRows.length === 0) continue;
    snapshots.push({
      corpCode: scope.corpCode,
      businessYear: scope.businessYear,
      reportCode: scope.reportCode,
      statementType,
      statementName: firstString(statementRows, "fs_nm"),
      receptionNo: firstString(statementRows, "rcept_no"),
      periodEnd: compactDate(firstString(statementRows, "thstrm_dt")),
      revenue: accountAmount(statementRows, REVENUE_NAMES),
      totalAssets: accountAmount(statementRows, ["자산총계"]),
      totalLiabilities: accountAmount(statementRows, ["부채총계"]),
      totalEquity: accountAmount(statementRows, ["자본총계"]),
      currency: firstString(statementRows, "currency"),
    });
  }
  return snapshots;
}

const REVENUE_NAMES = [
  "매출액",
  "영업수익",
  "수익(매출액)",
  "보험영업수익",
  "순영업수익",
] as const;

function accountAmount(rows: Record<string, unknown>[], names: readonly string[]): number | null {
  for (const name of names) {
    const row = rows.find((candidate) => normalizeAccountName(candidate.account_nm) === normalizeAccountName(name));
    if (!row) continue;
    const amount = numericValue(row.thstrm_amount);
    if (amount !== null) return amount;
  }
  return null;
}

function normalizeAccountName(value: unknown): string {
  return stringValue(value)?.replace(/\s+/g, "").replace(/[ⅠⅡⅢⅣⅤ]/g, "") ?? "";
}

async function fetchDartJson(
  url: URL,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DartFinancialAccountsError(`OpenDART 주요계정 응답 시간 초과(${timeout}ms)`, error);
    }
    throw new DartFinancialAccountsError(`OpenDART 주요계정 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new DartFinancialAccountsError(`OpenDART 주요계정 HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new DartFinancialAccountsError(`OpenDART 주요계정 응답이 JSON이 아닙니다: ${errorText(error)}`, error);
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DartFinancialAccountsError(message);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function firstString(rows: Record<string, unknown>[], key: string): string | null {
  for (const row of rows) {
    const value = stringValue(row[key]);
    if (value) return value;
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed.replace(/[(),\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function compactDate(value: string | null): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length !== 8) return value;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
