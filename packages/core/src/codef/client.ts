/**
 * CODEF 저수준 공통 POST 클라이언트 — 순수 인코딩/분류 + 네트워크 호출.
 *
 * 결정적 게이트: CODEF는 요청/응답 전문이 **양방향 URL 인코딩**이다.
 *  - 요청 body: encodeURIComponent(JSON.stringify(body)) 를 raw 텍스트로 전송
 *    (헤더 Content-Type: application/json, Authorization: Bearer <token>).
 *  - 응답 body: raw 텍스트를 JSON.parse(decodeURIComponent(rawText)) 로 파싱.
 *    일부 게이트웨이는 평문 JSON일 수 있어 decode 실패 시 raw JSON.parse 폴백.
 * 이 한 줄(양방향 처리)이 틀리면 모든 응답 파싱이 실패한다.
 *
 * 응답 봉투: { result:{code,message,transactionId}, data:{...} }.
 *   성공 CF-00000 → success, 추가인증 필요 CF-03002(+data.continue2Way) → two_way_required,
 *   그 외 코드 → CodefError throw.
 */

import type { CodefResult } from "./types.js";

/** 성공 코드. */
export const CODEF_SUCCESS_CODE = "CF-00000";
/** 추가인증(2-way) 필요 코드. */
export const CODEF_TWO_WAY_CODE = "CF-03002";

const DEFAULT_TIMEOUT_MS = 30_000;

/** CODEF 오류(전송/HTTP/파싱/비성공 코드). */
export class CodefError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly transactionId?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CodefError";
  }
}

/** classifyCodefResult 결과. */
export interface CodefClassification {
  status: "success" | "two_way_required";
  data: Record<string, unknown> | null;
  result: CodefResult;
}

/**
 * 요청 body 오브젝트를 CODEF 전송 텍스트(URL 인코딩된 JSON)로 만든다(순수).
 */
export function encodeCodefBody(obj: unknown): string {
  return encodeURIComponent(JSON.stringify(obj));
}

/**
 * CODEF 응답 raw 텍스트를 파싱한다(순수).
 * 1차: decodeURIComponent 후 JSON.parse(표준 전문). 실패 시 2차: raw JSON.parse(평문 게이트웨이).
 * 둘 다 실패하면 CodefError.
 */
export function decodeCodefResponse(rawText: string): unknown {
  const trimmed = (rawText ?? "").trim();
  if (!trimmed) {
    throw new CodefError("CODEF 응답 본문이 비어 있습니다.");
  }
  try {
    return JSON.parse(decodeURIComponent(trimmed));
  } catch {
    // 폴백: 평문 JSON(URL 인코딩 안 된 게이트웨이).
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new CodefError(`CODEF 응답 파싱 실패: ${errorText(error)}`, undefined, undefined, error);
  }
}

/**
 * 파싱된 봉투를 성공/추가인증/오류로 분류한다(순수).
 * - CF-00000 → success, CF-03002 → two_way_required, 그 외 → CodefError.
 */
export function classifyCodefResult(parsed: unknown): CodefClassification {
  const result = extractResult(parsed);
  const data = asRecord(asRecord(parsed)?.["data"]);
  if (result.code === CODEF_SUCCESS_CODE) {
    return { status: "success", data, result };
  }
  if (result.code === CODEF_TWO_WAY_CODE) {
    return { status: "two_way_required", data, result };
  }
  throw new CodefError(
    result.message || `CODEF 오류 응답 (${result.code || "코드 없음"})`,
    result.code || undefined,
    result.transactionId,
  );
}

/** requestCodefProduct 입력. */
export interface RequestCodefProductInput {
  /** 상품 API base(config.apiBaseUrl). */
  apiBaseUrl: string;
  /** 상품 경로(선행 슬래시 포함). 예 "/v1/kr/public/nt/proof-issue/corporate-registration". */
  path: string;
  /** 액세스 토큰. */
  accessToken: string;
  /** 요청 body 오브젝트(간편인증 파라미터 등). */
  body: Record<string, unknown>;
  /** 타임아웃(ms). 기본 30000. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입. */
  fetchImpl?: typeof fetch;
}

/**
 * 상품 API를 1회 호출하고 decode+classify 결과를 반환한다(네트워크).
 * 테스트에서는 호출하지 않는다(순수 함수만 fixture 검증).
 */
export async function requestCodefProduct(
  input: RequestCodefProductInput,
): Promise<CodefClassification> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = joinUrl(input.apiBaseUrl, input.path);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json",
      },
      body: encodeCodefBody(input.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CodefError(
        `CODEF 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
        undefined,
        undefined,
        error,
      );
    }
    throw new CodefError(`CODEF 요청 실패: ${errorText(error)}`, undefined, undefined, error);
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = decodeCodefResponse(rawText);
  } catch (error) {
    if (!response.ok) {
      throw new CodefError(
        `CODEF HTTP ${response.status} 응답 파싱 실패`,
        undefined,
        undefined,
        error,
      );
    }
    throw error;
  }
  return classifyCodefResult(parsed);
}

/** 봉투에서 result 오브젝트를 안전하게 꺼낸다. result가 없으면 throw. */
function extractResult(parsed: unknown): CodefResult {
  const resultRec = asRecord(asRecord(parsed)?.["result"]);
  if (!resultRec) {
    throw new CodefError("CODEF 응답에 result 봉투가 없습니다.");
  }
  const code = typeof resultRec["code"] === "string" ? resultRec["code"] : "";
  const message = typeof resultRec["message"] === "string" ? resultRec["message"] : "";
  const transactionId =
    typeof resultRec["transactionId"] === "string" ? resultRec["transactionId"] : undefined;
  const result: CodefResult = { code, message };
  if (transactionId !== undefined) result.transactionId = transactionId;
  return result;
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
