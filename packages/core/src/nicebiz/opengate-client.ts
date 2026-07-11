/**
 * NICE BizAPI(OpenGate) 저수준 게이트웨이 클라이언트 — dev 전용 데이터 소싱 하네스용.
 *
 * NICE 평가정보 기업정보 게이트웨이(nicebizline OpenGate)를 사업자번호(companyKey) path 세그먼트로
 * 조회한다. 인증은 HTTP 헤더 `client-id`/`client-secret`(각 앱키/시크릿). data.go.kr 과 달리
 * `response.header.resultCode` 래퍼가 없고, 성공은 HTTP 200 + `{ request, data }` 봉투다.
 * 호출부(dev 하네스)에서 fail-open 으로 다루므로 전송/HTTP/파싱 실패 시 throw 한다.
 *
 * 엔드포인트(실측 2026-07-11):
 *   BASE = https://api.nicebizline.com/api/opengate/v1
 *   예) GET {BASE}/company/overview/{companyKey}/indicator?tpCd=01&fatpCd=0
 *
 * 미프로비저닝(테스트앱에 오퍼레이션 미허용)은 HTTP 403("cannot find suitable entry ...")으로
 * 오는데, 이 경우 NiceBizNotProvisionedError(status=403)로 구분해 던져 호출부가 skip 처리하게 한다.
 */

/** OpenGate 게이트웨이 베이스(버전 세그먼트 v1 확정). */
export const NICE_OPENGATE_BASE = "https://api.nicebizline.com/api/opengate/v1";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CallOpenGateInput {
  /** 클라이언트 앱키(NICE_BIZ_CLIENT_APP_KEY). */
  appKey: string;
  /** 클라이언트 시크릿(NICE_BIZ_CLIENT_SECRET). */
  secret: string;
  /** BASE 뒤에 붙일 경로(선행 슬래시 포함). 예: "/company/overview/1248100998/indicator". */
  path: string;
  /** 쿼리 파라미터. undefined 값은 생략. */
  query?: Record<string, string | number | undefined>;
  /** 요청 타임아웃(ms). 기본 5000ms. */
  timeoutMs?: number;
  /** 테스트용 fetch 주입(기본 global fetch). */
  fetchImpl?: typeof fetch;
}

export class NiceBizError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    /** HTTP 상태(있으면). */
    readonly status?: number,
  ) {
    super(message);
    this.name = "NiceBizError";
  }
}

/**
 * 오퍼레이션이 테스트/데모 앱에 프로비저닝되지 않아 게이트웨이가 403 을 반환한 경우.
 * 호출부는 이 오류를 skip(pending 유지)으로 다뤄야 한다(실패 아님).
 */
export class NiceBizNotProvisionedError extends NiceBizError {
  constructor(message: string, cause?: unknown) {
    super(message, cause, 403);
    this.name = "NiceBizNotProvisionedError";
  }
}

/**
 * OpenGate 오퍼레이션을 1회 호출하고 파싱된 JSON(봉투 `{ request, data }`)을 반환한다.
 * - HTTP 403 → NiceBizNotProvisionedError(호출부 skip).
 * - 그 외 !ok / 네트워크 / 파싱 실패 → NiceBizError(호출부 fail-open).
 */
export async function callOpenGate(input: CallOpenGateInput): Promise<unknown> {
  const appKey = input.appKey?.trim();
  const secret = input.secret?.trim();
  if (!appKey || !secret) {
    throw new NiceBizError("Missing NICE BizAPI credentials (appKey/secret).");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildOpenGateUrl(input.path, input.query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "client-id": appKey,
        "client-secret": secret,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new NiceBizError(
        `NICE BizAPI 응답 시간 초과(${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms) · 게이트웨이 무응답`,
        error,
      );
    }
    throw new NiceBizError(`NICE BizAPI request failed: ${errorText(error)}`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new NiceBizNotProvisionedError(
      `NICE BizAPI 미프로비저닝(HTTP 403)${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new NiceBizError(
      `NICE BizAPI returned HTTP ${response.status}${body ? ` (${body.slice(0, 120).trim()})` : ""}`,
      undefined,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new NiceBizError(`NICE BizAPI response was not valid JSON: ${errorText(error)}`, error);
  }
}

/** BASE + path + query 로 완성된 URL 문자열을 만든다. */
export function buildOpenGateUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return `${NICE_OPENGATE_BASE}${normalizedPath}${qs ? `?${qs}` : ""}`;
}

/** 봉투에서 data 오브젝트를 안전하게 꺼낸다. */
export function extractData(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
