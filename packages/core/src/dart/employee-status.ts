/** OpenDART 직원 현황 API — 사업연도·보고서별 직원 스냅샷을 만든다. */

const DART_EMPLOYEE_ENDPOINT = "https://opendart.fss.or.kr/api/empSttus.json";
const DEFAULT_TIMEOUT_MS = 6_000;

export type DartReportCode = "11011" | "11012" | "11013" | "11014";

export interface DartEmployeeStatusSnapshot {
  corpCode: string;
  businessYear: string;
  reportCode: DartReportCode;
  receptionNo: string | null;
  settlementDate: string | null;
  totalEmployees: number | null;
  regularEmployees: number | null;
  contractEmployees: number | null;
  rowCount: number;
}

export interface CheckDartEmployeeStatusInput {
  apiKey: string;
  corpCode: string;
  businessYear: string;
  reportCode?: DartReportCode;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DartEmployeeStatusError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DartEmployeeStatusError";
  }
}

export async function checkDartEmployeeStatus(
  input: CheckDartEmployeeStatusInput,
): Promise<DartEmployeeStatusSnapshot | null> {
  const apiKey = input.apiKey.trim();
  const corpCode = input.corpCode.replace(/\D/g, "");
  const businessYear = input.businessYear.replace(/\D/g, "");
  const reportCode = input.reportCode ?? "11011";
  if (!apiKey) throw new DartEmployeeStatusError("OpenDART API 키가 없습니다.");
  if (corpCode.length !== 8) throw new DartEmployeeStatusError("OpenDART corp_code는 8자리여야 합니다.");
  if (businessYear.length !== 4) throw new DartEmployeeStatusError("OpenDART 사업연도는 4자리여야 합니다.");

  const url = new URL(DART_EMPLOYEE_ENDPOINT);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", businessYear);
  url.searchParams.set("reprt_code", reportCode);
  const payload = await fetchDartJson(url, input.fetchImpl, input.timeoutMs, "직원 현황");
  return parseDartEmployeeStatus(payload, { corpCode, businessYear, reportCode });
}

export function parseDartEmployeeStatus(
  payload: unknown,
  scope: { corpCode: string; businessYear: string; reportCode: DartReportCode },
): DartEmployeeStatusSnapshot | null {
  const root = record(payload, "OpenDART 직원 현황 응답 형식 오류");
  const status = stringValue(root.status);
  if (status === "013") return null;
  if (status !== "000") throw dartStatusError("직원 현황", root);
  if (!Array.isArray(root.list)) throw new DartEmployeeStatusError("OpenDART 직원 현황 list 누락");
  if (root.list.length === 0) return null;

  const rows = root.list.map((item) => record(item, "OpenDART 직원 현황 행 형식 오류"));
  // 일부 공시는 사업부·성별 상세행 뒤에 "성별합계" 행을 함께 준다. 합계행이 있으면
  // 상세행까지 다시 더하지 않고 합계행만 사용한다.
  const aggregateRows = rows.filter((row) => /합계/.test(stringValue(row.fo_bbm) ?? ""));
  const countRows = aggregateRows.length > 0 ? aggregateRows : rows;
  return {
    corpCode: scope.corpCode,
    businessYear: scope.businessYear,
    reportCode: scope.reportCode,
    receptionNo: firstString(rows, "rcept_no"),
    settlementDate: compactDate(firstString(rows, "stlm_dt")),
    totalEmployees: sumNullable(countRows.map((row) => numericValue(row.sm))),
    regularEmployees: sumNullable(countRows.map((row) => numericValue(row.rgllbr_co))),
    contractEmployees: sumNullable(countRows.map((row) => numericValue(row.cnttk_co))),
    rowCount: rows.length,
  };
}

async function fetchDartJson(
  url: URL,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number | undefined,
  label: string,
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
      throw new DartEmployeeStatusError(`OpenDART ${label} 응답 시간 초과(${timeout}ms)`, error);
    }
    throw new DartEmployeeStatusError(`OpenDART ${label} 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new DartEmployeeStatusError(`OpenDART ${label} HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new DartEmployeeStatusError(`OpenDART ${label} 응답이 JSON이 아닙니다: ${errorText(error)}`, error);
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DartEmployeeStatusError(message);
  return value as Record<string, unknown>;
}

function dartStatusError(label: string, root: Record<string, unknown>): DartEmployeeStatusError {
  const status = stringValue(root.status) ?? "unknown";
  const message = stringValue(root.message);
  return new DartEmployeeStatusError(`OpenDART ${label} status=${status}${message ? ` (${message})` : ""}`);
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
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized || normalized === "-") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function compactDate(value: string | null): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length !== 8) return value;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
