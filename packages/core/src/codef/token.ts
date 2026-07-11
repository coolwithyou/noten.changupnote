/**
 * CODEF OAuth 토큰 — 순수 파싱/만료판정 + 네트워크 발급.
 *
 * 토큰: POST https://oauth.codef.io/oauth/token
 *   헤더 Authorization: Basic base64(clientId:clientSecret), Content-Type: x-www-form-urlencoded
 *   body grant_type=client_credentials&scope=read
 *   응답(평문 JSON) { access_token, token_type:"bearer", expires_in:604799 }
 *
 * accessToken 유효 ≈7일. 실제 캐시(DB 저장·재사용)는 Phase B web 레이어 몫이고, 코어는
 * 순수 파싱(parseTokenResponse)과 만료 판정(isCodefTokenExpired)만 담당한다.
 * requestCodefToken(네트워크)은 fixture 테스트에서 제외한다.
 */

import type { CodefEnvConfig, CodefToken } from "./types.js";

/** 만료 판정 기본 여유(초). 만료 1시간 전이면 만료 취급해 선제 재발급 유도. */
export const DEFAULT_TOKEN_SKEW_SEC = 3600;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** 토큰 발급/파싱 실패. */
export class CodefTokenError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CodefTokenError";
  }
}

/**
 * 토큰 응답 JSON을 CodefToken으로 파싱한다(순수). access_token이 없으면 throw.
 * @param nowMs 발급 시각(테스트 주입용). 기본 Date.now().
 */
export function parseTokenResponse(json: unknown, nowMs: number = Date.now()): CodefToken {
  const rec = asRecord(json);
  const accessToken = typeof rec?.["access_token"] === "string" ? rec["access_token"] : "";
  if (!accessToken) {
    throw new CodefTokenError("CODEF 토큰 응답에 access_token이 없습니다.");
  }
  const tokenType = typeof rec?.["token_type"] === "string" ? rec["token_type"] : "bearer";
  const expiresInSec = toPositiveInt(rec?.["expires_in"]);
  return {
    accessToken,
    tokenType,
    expiresInSec,
    obtainedAtMs: nowMs,
  };
}

/**
 * 토큰이 만료(임박)됐는지 판정한다(순수).
 * nowMs ≥ (발급시각 + 유효초 − 여유초) 이면 만료로 본다.
 */
export function isCodefTokenExpired(
  token: CodefToken,
  nowMs: number = Date.now(),
  skewSec: number = DEFAULT_TOKEN_SKEW_SEC,
): boolean {
  const expiryMs = token.obtainedAtMs + token.expiresInSec * 1000;
  return nowMs >= expiryMs - skewSec * 1000;
}

/**
 * OAuth client_credentials 토큰을 발급받는다(네트워크). 테스트에서는 호출하지 않는다.
 * @param nowMs 발급 시각(테스트 주입용).
 */
export async function requestCodefToken(
  config: CodefEnvConfig,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<CodefToken> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "read",
  }).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new CodefTokenError(`CODEF 토큰 요청 실패: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CodefTokenError(
      `CODEF 토큰 발급 실패(HTTP ${response.status})${text ? `: ${text.slice(0, 160).trim()}` : ""}`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new CodefTokenError("CODEF 토큰 응답 JSON 파싱 실패", error);
  }
  return parseTokenResponse(json, nowMs);
}

/** unknown → 양의 정수(초). 파싱 불가/음수면 0(즉시 만료 취급). */
function toPositiveInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
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
