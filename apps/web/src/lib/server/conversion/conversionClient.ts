// Phase 2 T7~T8: 변환 서버(apps/conversion) 서버-투-서버 클라이언트.
// 계획: docs/phase2-conversion-server-implementation-plan.md (4장 API 계약, 8장 웹앱 연동)
//
// - CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET 미설정 시 클라이언트는 null.
//   호출부는 no-op 처리하여 기존 아카이브 동작을 그대로 보존한다 (계획 8.1 fire-and-forget).
// - 웹앱은 이 클라이언트로만 변환 서버를 호출한다 (공개 노출 안 함, 공유 시크릿 헤더).

/** POST /v1/conversion-jobs 요청 본문 (계획 4.1). */
export interface ConversionJobRequest {
  jobId: string;
  source: string;
  sourceId: string;
  surfaceId?: string;
  filename: string;
  sourceObjectUrl: string;
  sha256: string;
  requestedArtifacts?: string[];
  options?: { pageImageDpi?: 220 | 300 };
}

/** GET /:jobId/artifacts 응답의 artifact 1건 (계획 4.3). document_artifacts 행 1개에 대응. */
export interface ConversionArtifact {
  kind: string;
  page?: number;
  storageKey: string;
  url: string | null;
  sha256: string | null;
  contentType: string | null;
  metadata: Record<string, unknown>;
}

/** POST 응답 (계획 4.1). 캐시 히트면 succeeded + artifacts 즉시 반환. */
export interface EnqueueJobResponse {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  cached: boolean;
  artifacts?: ConversionArtifact[];
}

/** GET /:jobId 응답 (계획 4.2). */
export interface JobStatusResponse {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  converterVersion: string;
  cached?: boolean;
  quality: {
    renderEngine: string | null;
    pdfRendered: boolean;
    pageImagesRendered: boolean;
    textExtracted: boolean;
    pageCount: number;
    pageImageDpi: number;
    textCoverage: number;
    warnings: string[];
    status: string;
  } | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /:jobId/artifacts 응답 (계획 4.3). */
export interface JobArtifactsResponse {
  jobId: string;
  artifacts: ConversionArtifact[];
}

export interface ConversionClient {
  /** 변환 job 등록. 캐시 히트면 response.cached=true + artifacts 포함. */
  enqueueJob(request: ConversionJobRequest): Promise<EnqueueJobResponse>;
  /** job 상태 폴링. 404면 null. */
  getJob(jobId: string): Promise<JobStatusResponse | null>;
  /** artifact 목록 조회. 404면 null. */
  getArtifacts(jobId: string): Promise<JobArtifactsResponse | null>;
}

export interface ConversionClientConfig {
  baseUrl: string;
  sharedSecret: string;
  /** 요청 타임아웃 ms (기본 30초). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 환경변수에서 변환 클라이언트를 만든다.
 * CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET 둘 다 있어야 하며,
 * 하나라도 없으면 null (호출부는 no-op — 기존 아카이브 동작 보존, 계획 8.1).
 */
export function createConversionClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConversionClient | null {
  const baseUrl = env.CONVERSION_SERVER_URL?.trim();
  const sharedSecret = env.CONVERSION_SHARED_SECRET?.trim();
  if (!baseUrl || !sharedSecret) return null;
  return createConversionClient({
    baseUrl,
    sharedSecret,
    ...(env.CONVERSION_CLIENT_TIMEOUT_MS?.trim()
      ? { timeoutMs: Number(env.CONVERSION_CLIENT_TIMEOUT_MS.trim()) || 30_000 }
      : {}),
  });
}

export function createConversionClient(config: ConversionClientConfig): ConversionClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const secret = config.sharedSecret;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-shared-secret": secret,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async enqueueJob(jobRequest) {
      const { status, json } = await request("POST", "/v1/conversion-jobs", jobRequest);
      if (status !== 200 && status !== 202) {
        throw new Error(
          `변환 job 등록 실패: HTTP ${status} ${describeError(json)}`,
        );
      }
      return json as EnqueueJobResponse;
    },
    async getJob(jobId) {
      const { status, json } = await request(
        "GET",
        `/v1/conversion-jobs/${encodeURIComponent(jobId)}`,
      );
      if (status === 404) return null;
      if (status !== 200) {
        throw new Error(`변환 job 조회 실패: HTTP ${status} ${describeError(json)}`);
      }
      return json as JobStatusResponse;
    },
    async getArtifacts(jobId) {
      const { status, json } = await request(
        "GET",
        `/v1/conversion-jobs/${encodeURIComponent(jobId)}/artifacts`,
      );
      if (status === 404) return null;
      if (status !== 200) {
        throw new Error(
          `변환 artifact 조회 실패: HTTP ${status} ${describeError(json)}`,
        );
      }
      return json as JobArtifactsResponse;
    },
  };
}

function describeError(json: unknown): string {
  if (json && typeof json === "object" && "error" in json) {
    return String((json as { error: unknown }).error);
  }
  return "";
}
