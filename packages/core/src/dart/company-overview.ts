/** OpenDART 기업개황 API — corp_code를 사업자번호·법인등록번호로 exact 검증한다. */

const DART_COMPANY_ENDPOINT = "https://opendart.fss.or.kr/api/company.json";
const DEFAULT_TIMEOUT_MS = 6_000;

export interface DartCompanyOverview {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
  corpClass: string | null;
  businessRegistrationNumber: string;
  corporateRegistrationNumber: string | null;
  establishedOn: string | null;
  industryCode: string | null;
}

export interface CheckDartCompanyOverviewInput {
  apiKey: string;
  corpCode: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DartCompanyError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DartCompanyError";
  }
}

export async function checkDartCompanyOverview(
  input: CheckDartCompanyOverviewInput,
): Promise<DartCompanyOverview | null> {
  const apiKey = input.apiKey.trim();
  const corpCode = input.corpCode.replace(/\D/g, "");
  if (!apiKey) throw new DartCompanyError("OpenDART API 키가 없습니다.");
  if (corpCode.length !== 8) throw new DartCompanyError("OpenDART corp_code는 8자리여야 합니다.");
  const url = new URL(DART_COMPANY_ENDPOINT);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, { headers: { Accept: "application/json" }, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DartCompanyError(`OpenDART 기업개황 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`, error);
    }
    throw new DartCompanyError(`OpenDART 기업개황 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new DartCompanyError(`OpenDART 기업개황 HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DartCompanyError(`OpenDART 기업개황 응답이 JSON이 아닙니다: ${errorText(error)}`, error);
  }
  return parseDartCompanyOverview(payload);
}

export function parseDartCompanyOverview(payload: unknown): DartCompanyOverview | null {
  if (!payload || typeof payload !== "object") throw new DartCompanyError("OpenDART 기업개황 응답 형식 오류");
  const row = payload as Record<string, unknown>;
  const status = text(row.status);
  if (status === "013") return null;
  if (status !== "000") throw new DartCompanyError(`OpenDART 기업개황 status=${status ?? "unknown"}${text(row.message) ? ` (${text(row.message)})` : ""}`);
  const corpCode = digits(row.corp_code);
  const corpName = text(row.corp_name);
  const bizNo = digits(row.bizr_no);
  if (corpCode.length !== 8 || !corpName || bizNo.length !== 10) {
    throw new DartCompanyError("OpenDART 기업개황 필수 필드 누락");
  }
  const corpRegNo = digits(row.jurir_no);
  return {
    corpCode,
    corpName,
    stockCode: nullableDigits(row.stock_code, 6),
    corpClass: text(row.corp_cls),
    businessRegistrationNumber: bizNo,
    corporateRegistrationNumber: corpRegNo.length === 13 ? corpRegNo : null,
    establishedOn: dateKey(row.est_dt),
    industryCode: text(row.induty_code),
  };
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function digits(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function nullableDigits(value: unknown, length: number): string | null {
  const valueDigits = digits(value);
  return valueDigits.length === length ? valueDigits : null;
}

function dateKey(value: unknown): string | null {
  const valueDigits = digits(value);
  return valueDigits.length === 8 ? valueDigits : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
