// 변환 서버 POST /v1/hwp-markdown 동기 클라이언트.
// Vercel 인제스트 환경에는 pyhwp(hwp5html)가 없어 HWP→markdown 로컬 변환이 전부 실패한다 —
// pyhwp 가 설치된 Cloud Run 변환 서버에 위임하기 위한 얇은 클라이언트.
// conversionClient.ts 와 같은 규약: env 둘 다 있어야 생성, 없으면 null(호출부 no-op).

export interface RemoteHwpMarkdownRequest {
  filename: string;
  /** 변환 서버가 직접 다운로드할 R2 presigned GET URL. */
  sourceObjectUrl: string;
  sha256?: string;
}

export interface RemoteHwpMarkdownResult {
  markdown: string;
  converter: string;
}

export interface RemoteHwpMarkdownClient {
  convert(request: RemoteHwpMarkdownRequest): Promise<RemoteHwpMarkdownResult>;
}

export interface RemoteHwpMarkdownConfig {
  baseUrl: string;
  sharedSecret: string;
  /** 요청 타임아웃 ms (기본 60초 — 동기 변환이라 conversionClient 보다 여유). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 환경변수에서 원격 변환 클라이언트를 만든다.
 * CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET 둘 다 있어야 하며,
 * 하나라도 없으면 null (호출부는 로컬 변환기만으로 기존 동작 유지).
 */
export function createRemoteHwpMarkdownFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RemoteHwpMarkdownClient | null {
  const baseUrl = env.CONVERSION_SERVER_URL?.trim();
  const sharedSecret = env.CONVERSION_SHARED_SECRET?.trim();
  if (!baseUrl || !sharedSecret) return null;
  return createRemoteHwpMarkdown({ baseUrl, sharedSecret });
}

export function createRemoteHwpMarkdown(config: RemoteHwpMarkdownConfig): RemoteHwpMarkdownClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 60_000;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async convert(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/v1/hwp-markdown`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shared-secret": config.sharedSecret,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const text = await res.text();
        let json: unknown = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = { error: text };
          }
        }
        if (res.status !== 200) {
          throw new Error(`원격 hwp markdown 변환 실패: HTTP ${res.status} ${describeError(json)}`);
        }
        const body = json as { markdown?: unknown; converter?: unknown };
        if (typeof body?.markdown !== "string" || typeof body?.converter !== "string") {
          throw new Error("원격 hwp markdown 변환 실패: 응답 형식 오류");
        }
        return { markdown: body.markdown, converter: body.converter };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`원격 hwp markdown 변환 타임아웃 (${timeoutMs}ms)`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function describeError(json: unknown): string {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (typeof o.code === "string") return o.code;
  }
  return "";
}
