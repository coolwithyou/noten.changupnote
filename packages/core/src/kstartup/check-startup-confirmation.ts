/**
 * 창업진흥원 창업기업확인서 발급 기업 정보(공공데이터포털 15125362).
 * 사업자번호 exact 조회 후 현재 유효/만료/발급예정/미조회 상태를 분류한다.
 */

const STARTUP_CONFIRMATION_ENDPOINT =
  "https://apis.data.go.kr/B552735/kisedCertService/getCorporateInformation";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface StartupConfirmationRecord {
  businessRegistrationNumber: string;
  corporateRegistrationNumber: string | null;
  companyName: string | null;
  companyType: string | null;
  certificateNumber: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
}

export type StartupConfirmationState = "active" | "expired" | "future" | "invalid" | "none";

export interface StartupConfirmationLookup {
  state: StartupConfirmationState;
  record: StartupConfirmationRecord | null;
  exactRecordCount: number;
}

export interface CheckStartupConfirmationInput {
  serviceKey: string;
  bizNo: string;
  now?: Date;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class StartupConfirmationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StartupConfirmationError";
  }
}

export async function checkStartupConfirmation(
  input: CheckStartupConfirmationInput,
): Promise<StartupConfirmationLookup> {
  const bizNo = sanitizeDigits(input.bizNo);
  if (bizNo.length !== 10) throw new StartupConfirmationError("창업기업확인서 사업자번호는 10자리여야 합니다.");
  const serviceKey = input.serviceKey.trim();
  if (!serviceKey) throw new StartupConfirmationError("공공데이터포털 인증키가 없습니다.");

  const url = buildStartupConfirmationUrl(serviceKey, bizNo);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new StartupConfirmationError(
        `창업기업확인서 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
        error,
      );
    }
    throw new StartupConfirmationError(`창업기업확인서 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new StartupConfirmationError(
      `창업기업확인서 HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new StartupConfirmationError(`창업기업확인서 응답이 JSON이 아닙니다: ${errorText(error)}`, error);
  }
  return parseStartupConfirmation(payload, bizNo, input.now ?? new Date());
}

export function buildStartupConfirmationUrl(serviceKey: string, bizNo: string): string {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    "page=1",
    "perPage=100",
    "returnType=json",
    `cond%5Bbrno%3A%3AEQ%5D=${encodeURIComponent(sanitizeDigits(bizNo))}`,
  ].join("&");
  return `${STARTUP_CONFIRMATION_ENDPOINT}?${params}`;
}

export function parseStartupConfirmation(
  payload: unknown,
  bizNo: string,
  now: Date,
): StartupConfirmationLookup {
  const requestedBizNo = sanitizeDigits(bizNo);
  const records = extractItems(payload)
    .map(normalizeRecord)
    .filter((record): record is StartupConfirmationRecord => record !== null)
    .filter((record) => sanitizeDigits(record.businessRegistrationNumber) === requestedBizNo);
  return classifyStartupConfirmation(records, now);
}

export function classifyStartupConfirmation(
  records: StartupConfirmationRecord[],
  now: Date,
): StartupConfirmationLookup {
  if (records.length === 0) return { state: "none", record: null, exactRecordCount: 0 };
  const today = toSeoulDateKey(now);
  const valid = records.filter((record) => record.issuedOn && record.expiresOn);
  const active = valid
    .filter((record) => record.issuedOn! <= today && today <= record.expiresOn!)
    .sort((a, b) => b.expiresOn!.localeCompare(a.expiresOn!));
  if (active[0]) return { state: "active", record: active[0], exactRecordCount: records.length };

  const future = valid
    .filter((record) => record.issuedOn! > today)
    .sort((a, b) => a.issuedOn!.localeCompare(b.issuedOn!));
  if (future[0]) return { state: "future", record: future[0], exactRecordCount: records.length };

  const expired = valid
    .filter((record) => record.expiresOn! < today)
    .sort((a, b) => b.expiresOn!.localeCompare(a.expiresOn!));
  if (expired[0]) return { state: "expired", record: expired[0], exactRecordCount: records.length };
  return { state: "invalid", record: records[0] ?? null, exactRecordCount: records.length };
}

function extractItems(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const nested = (data as Record<string, unknown>).data;
  return Array.isArray(nested) ? nested : [];
}

function normalizeRecord(value: unknown): StartupConfirmationRecord | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const brno = textOrNull(item.brno);
  if (!brno) return null;
  return {
    businessRegistrationNumber: brno,
    corporateRegistrationNumber: textOrNull(item.crno),
    companyName: textOrNull(item.ntrp_nm),
    companyType: textOrNull(item.ntrp_type_nm),
    certificateNumber: textOrNull(item.confmdoc_isu_no),
    issuedOn: dateKeyOrNull(item.confmdoc_isu_dt),
    expiresOn: dateKeyOrNull(item.confmdoc_expr_dt),
  };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function dateKeyOrNull(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length === 8 ? digits : null;
}

function toSeoulDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function sanitizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
