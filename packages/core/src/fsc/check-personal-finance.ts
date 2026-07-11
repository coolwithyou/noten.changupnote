/**
 * 금융위원회 개인사업자재무정보 — 공공데이터포털 OpenAPI(15108171).
 *
 * ⚠️ 실측 반증(2026-07-11): 이 데이터셋은 사업자번호로 특정 사업자를 조회하는 API가 아니라
 * **익명 집계 통계 마이크로데이터**다. `bzno` 파라미터를 넣어도 무시되고(정상2·무효1 사업자번호
 * 모두 totalCount=416643 동일), 응답 item 에 사업자번호/상호 식별자가 전혀 없다.
 * 반환 필드는 익명 버킷: rprSexNm(성별)·rprAggrNm(연령대)·bizAreaNm(지역)·bizBzcCdNm(업종)
 * ·empeCntNm(종업원수 구간)·saleAmt·debtTsumAmt 등. → **특정 개인사업자 매출/재무 조회 불가.**
 *
 * 따라서 이 커넥터는 값을 매핑하지 않고, 응답이 "익명 집계셋"임을 분류만 한다. dev 하네스는
 * 이를 schemaMismatch(실패)로 렌더해 "이 소스로는 개인 매출을 못 채운다"는 사실을 노출한다.
 * (개인사업자 확정매출은 CODEF 부가세과세표준 경로만 — 소싱 설계 §6 참조.)
 *
 * 엔드포인트(실측):
 *   GET http://apis.data.go.kr/1160100/service/GetSBFinanceInfoService/getFnafInfo
 *     ?serviceKey={key}&bzno=<무시됨>&numOfRows=&pageNo=&resultType=json
 */

const FSC_PERSONAL_FINANCE_ENDPOINT =
  "http://apis.data.go.kr/1160100/service/GetSBFinanceInfoService/getFnafInfo";
const DEFAULT_TIMEOUT_MS = 5_000;

/** 응답 분류. aggregate=익명 집계셋(사업자 식별 불가) / empty=아이템 없음. */
export type FscPersonalFinanceKind = "aggregate" | "empty";

export interface FscPersonalFinanceClassification {
  kind: FscPersonalFinanceKind;
  /** 전체 건수(집계셋이면 데이터셋 전체 규모). */
  totalCount: number | null;
  /** item 이 사업자번호/상호 식별자를 포함하는지(현재 false — 익명셋 근거). */
  hasBusinessIdentifier: boolean;
  /** 첫 item 의 필드 키 샘플(진단·보고용). */
  sampleFields: string[];
}

export interface CheckFscPersonalFinanceInput {
  serviceKey: string;
  /** 조회 시도 사업자번호(실제로는 API가 무시). */
  bizNo: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class FscPersonalFinanceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FscPersonalFinanceError";
  }
}

/** 사업자 식별자로 쓰일 수 있는 후보 키(응답에 있으면 per-business 조회 가능 신호). */
const BUSINESS_ID_KEYS = ["bzno", "brno", "bizno", "saeopjaNo", "corpNo"] as const;

/**
 * getFnafInfo 를 1회 호출하고 응답을 분류한다(값 매핑 없음).
 * HTTP/파싱 실패 시 throw(호출부 fail-open).
 */
export async function checkFscPersonalFinance(
  input: CheckFscPersonalFinanceInput,
): Promise<FscPersonalFinanceClassification> {
  const bizNo = (input.bizNo ?? "").replace(/\D/g, "");
  const serviceKey = input.serviceKey?.trim();
  if (!serviceKey) {
    throw new FscPersonalFinanceError("Missing FSC finance service key.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildFscPersonalFinanceUrl(serviceKey, bizNo);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new FscPersonalFinanceError(`FSC personal finance request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new FscPersonalFinanceError(
      `FSC personal finance returned HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new FscPersonalFinanceError(`FSC personal finance response was not valid JSON: ${errorText(error)}`, error);
  }

  return classifyFscPersonalFinance(payload);
}

/** 응답을 aggregate/empty 로 분류한다(순수 함수). */
export function classifyFscPersonalFinance(payload: unknown): FscPersonalFinanceClassification {
  const resultCode = getPath(payload, ["response", "header", "resultCode"]);
  if (typeof resultCode === "string" && resultCode !== "00") {
    const msg = getPath(payload, ["response", "header", "resultMsg"]);
    throw new FscPersonalFinanceError(
      `FSC personal finance resultCode=${resultCode}${typeof msg === "string" ? ` (${msg})` : ""}`,
    );
  }
  const body = getPath(payload, ["response", "body"]);
  const totalCount = numberOrNull(getPath(body, ["totalCount"]));
  const rawItems = getPath(body, ["items", "item"]);
  const items = Array.isArray(rawItems) ? rawItems : rawItems && typeof rawItems === "object" ? [rawItems] : [];
  if (items.length === 0) {
    return { kind: "empty", totalCount, hasBusinessIdentifier: false, sampleFields: [] };
  }
  const first = items[0] as Record<string, unknown>;
  const sampleFields = Object.keys(first);
  const hasBusinessIdentifier = BUSINESS_ID_KEYS.some((key) => key in first);
  return {
    kind: "aggregate",
    totalCount,
    hasBusinessIdentifier,
    sampleFields,
  };
}

export function buildFscPersonalFinanceUrl(serviceKey: string, bizNo: string): string {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    `bzno=${encodeURIComponent(bizNo)}`,
    "numOfRows=1",
    "pageNo=1",
    "resultType=json",
  ].join("&");
  return `${FSC_PERSONAL_FINANCE_ENDPOINT}?${params}`;
}

function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function encodeServiceKey(serviceKey: string): string {
  return /%[0-9A-Fa-f]{2}/.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
