// admin(apps/admin) → 웹앱(apps/web) 내부 엔드포인트 호출 헬퍼 (설계 9.3 "admin 결제 실행 경로").
//
// 포트원·원장 실행 로직은 웹앱에 단일 구현으로 존재한다. admin 은 role 검사·감사 기록 후 이 헬퍼로
// 웹앱의 /api/internal/credits/* 를 서버 간 시크릿 헤더로 호출한다(7.5 "portone.ts 밖 직접 호출 금지" 유지).
//
// - WEB_INTERNAL_BASE_URL: 웹앱 기저 URL(로컬=dev 서버 주소, 운영=웹 프로덕션 도메인).
// - INTERNAL_API_SECRET: 웹앱 authorizeInternalRequest 와 동일 값. x-internal-secret 헤더로 전달.
// - 웹 미기동·시크릿 미설정 시 명확한 오류(503 web_internal_unavailable)로 실패한다.

const INTERNAL_SECRET_HEADER = "x-internal-secret";
const DEFAULT_TIMEOUT_MS = 15_000;

export class WebInternalUnavailableError extends Error {
  readonly status = 503;
  readonly code = "web_internal_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "WebInternalUnavailableError";
  }
}

/** 웹 내부 엔드포인트 응답. ok=false 면 error(웹이 반환한 code/message/status). */
export interface WebInternalResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

function resolveConfig(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.WEB_INTERNAL_BASE_URL?.trim();
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!baseUrl || !secret) {
    throw new WebInternalUnavailableError(
      "WEB_INTERNAL_BASE_URL / INTERNAL_API_SECRET 미설정 — 웹앱 내부 실행 경로를 사용할 수 없습니다.",
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

/**
 * 웹앱 내부 엔드포인트를 POST 로 호출한다.
 * @param path "/api/internal/credits/..." 형식(선행 슬래시 포함).
 * @param body JSON 직렬화할 본문(없으면 미전송).
 */
export async function callWebInternal<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<WebInternalResponse<T>> {
  const { baseUrl, secret } = resolveConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_SECRET_HEADER]: secret,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : { body: "{}" }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    const ok = res.ok && json.ok !== false;
    const result: WebInternalResponse<T> = { ok, status: res.status };
    if (json.data !== undefined) result.data = json.data as T;
    if (json.error && typeof json.error === "object") {
      const e = json.error as { code?: string; message?: string };
      result.error = { code: e.code ?? "web_internal_error", message: e.message ?? "웹 내부 호출 오류" };
    } else if (!ok) {
      result.error = { code: "web_internal_error", message: `웹 내부 호출 실패(HTTP ${res.status})` };
    }
    return result;
  } catch (error) {
    if (error instanceof WebInternalUnavailableError) throw error;
    throw new WebInternalUnavailableError(
      `웹앱 내부 엔드포인트 호출 실패: ${error instanceof Error ? error.message : "네트워크 오류"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
