// T6: HTTP API 3종 (계획 4장) — node 내장 http 모듈.
//   POST /v1/conversion-jobs            job 등록 (비동기). 캐시 히트면 즉시 succeeded.
//   GET  /v1/conversion-jobs/:jobId     상태 폴링.
//   GET  /v1/conversion-jobs/:jobId/artifacts   artifact 목록.
//   POST /v1/hwp-markdown               HWP→markdown 동기 변환 (인제스트 위임용, 큐 미경유).
// 인증: shared secret 헤더 (x-shared-secret 또는 Authorization: Bearer). env CONVERSION_SHARED_SECRET.
//
// 웹앱이 서버-투-서버로만 호출한다 (공개 노출 안 함).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConversionQueue, type ConversionJobRequest, type FetchSourceFn } from "./queue.js";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "./storage.js";
import type { HwpToMarkdownFn, HwpxConvertFn } from "./convert-document.js";
import { sha256Hex } from "./integrity.js";

export interface ServerConfig {
  queue: ConversionQueue;
  /** shared secret. 미지정 시 env CONVERSION_SHARED_SECRET. 비면 인증 비활성(경고). */
  sharedSecret?: string;
  /** 요청 본문 최대 바이트 (기본 256KB — 메타데이터만 받으므로 작다). */
  maxBodyBytes?: number;
  /** HWP→markdown 변환 함수 주입 (동기 엔드포인트용. 미주입 시 503). */
  hwpToMarkdown?: HwpToMarkdownFn;
  /** 원본 다운로드 함수 (기본: global fetch. 테스트에서 대체 가능). */
  fetchSource?: FetchSourceFn;
  /** 동기 변환 원본 파일 최대 바이트 (기본 30MB). */
  hwpMarkdownMaxSourceBytes?: number;
}

const DEFAULT_MAX_BODY = 256 * 1024;
/** 동기 변환은 작은 파일 텍스트 추출 용도 — 원본 30MB 가드. */
const DEFAULT_MAX_SOURCE_BYTES = 30 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 요청 헤더에서 shared secret 추출 (x-shared-secret 또는 Bearer). */
function extractSecret(req: IncomingMessage): string | null {
  const header = req.headers["x-shared-secret"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return null;
}

/** 상수시간 비교 (타이밍 공격 완화). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 요청 검증. 누락 필드가 있으면 사유 문자열, 통과면 null. */
function validateJobRequest(v: unknown): { ok: true; value: ConversionJobRequest } | { ok: false; reason: string } {
  if (typeof v !== "object" || v === null) return { ok: false, reason: "body must be an object" };
  const o = v as Record<string, unknown>;
  const required = ["jobId", "source", "sourceId", "filename", "sourceObjectUrl", "sha256"] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) {
      return { ok: false, reason: `missing or invalid field: ${k}` };
    }
  }
  const optsRaw = o.options as Record<string, unknown> | undefined;
  const dpiRaw = optsRaw?.pageImageDpi;
  const dpi = dpiRaw === 300 ? 300 : dpiRaw === 220 ? 220 : undefined;
  /** 안전 상한 옵션: 양의 정수만 통과 (job 단위 튜닝·타임아웃 주입용, 계획 11장). */
  const posInt = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isInteger(x) && x > 0 ? x : undefined;
  const sofficeTimeoutMs = posInt(optsRaw?.sofficeTimeoutMs);
  const maxBytes = posInt(optsRaw?.maxBytes);
  const maxPages = posInt(optsRaw?.maxPages);
  const options: NonNullable<ConversionJobRequest["options"]> = {
    ...(dpi !== undefined ? { pageImageDpi: dpi } : {}),
    ...(sofficeTimeoutMs !== undefined ? { sofficeTimeoutMs } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  };
  const request: ConversionJobRequest = {
    jobId: o.jobId as string,
    source: o.source as string,
    sourceId: o.sourceId as string,
    filename: o.filename as string,
    sourceObjectUrl: o.sourceObjectUrl as string,
    sha256: o.sha256 as string,
    ...(typeof o.surfaceId === "string" ? { surfaceId: o.surfaceId } : {}),
    ...(Array.isArray(o.requestedArtifacts)
      ? { requestedArtifacts: (o.requestedArtifacts as unknown[]).filter((x): x is string => typeof x === "string") }
      : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
  return { ok: true, value: request };
}

/** POST /v1/hwp-markdown 요청 검증. 계약: filename(.hwp/.hwpx) + sourceObjectUrl(presigned GET) + sha256?. */
function validateHwpMarkdownRequest(
  v: unknown,
): { ok: true; value: { filename: string; sourceObjectUrl: string; sha256?: string } } | { ok: false; reason: string } {
  if (typeof v !== "object" || v === null) return { ok: false, reason: "body must be an object" };
  const o = v as Record<string, unknown>;
  if (typeof o.filename !== "string" || o.filename.length === 0) {
    return { ok: false, reason: "missing or invalid field: filename" };
  }
  if (!/\.(?:hwp|hwpx)$/i.test(o.filename)) {
    return { ok: false, reason: "filename must end with .hwp or .hwpx" };
  }
  if (typeof o.sourceObjectUrl !== "string" || o.sourceObjectUrl.length === 0) {
    return { ok: false, reason: "missing or invalid field: sourceObjectUrl" };
  }
  if (o.sha256 !== undefined && (typeof o.sha256 !== "string" || o.sha256.length === 0)) {
    return { ok: false, reason: "invalid field: sha256" };
  }
  return {
    ok: true,
    value: {
      filename: o.filename,
      sourceObjectUrl: o.sourceObjectUrl,
      ...(typeof o.sha256 === "string" ? { sha256: o.sha256 } : {}),
    },
  };
}

/** GET /:jobId 응답 shape (계획 4.2). */
function jobStatusResponse(queue: ConversionQueue, jobId: string): unknown | null {
  const rec = queue.get(jobId);
  if (!rec) return null;
  return {
    jobId: rec.jobId,
    status: rec.status,
    converterVersion: rec.converterVersion,
    cached: rec.cached,
    quality: rec.quality
      ? {
          renderEngine: rec.quality.renderEngine,
          pdfRendered: rec.quality.pdfRendered,
          pageImagesRendered: rec.quality.pageImagesRendered,
          textExtracted: rec.quality.textExtracted,
          pageCount: rec.quality.pageCount,
          pageImageDpi: rec.quality.pageImageDpi,
          textCoverage: rec.quality.textCoverage,
          warnings: rec.quality.warnings,
          status: rec.quality.status,
        }
      : null,
    error: rec.error,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

/** GET /:jobId/artifacts 응답 shape (계획 4.3). */
function artifactsResponse(queue: ConversionQueue, jobId: string): unknown | null {
  const rec = queue.get(jobId);
  if (!rec) return null;
  return {
    jobId: rec.jobId,
    artifacts: rec.artifacts.map((a) => ({
      kind: a.kind,
      ...(a.page !== null ? { page: a.page } : {}),
      storageKey: a.storageKey,
      url: a.url,
      sha256: a.sha256,
      contentType: a.contentType,
      metadata: a.metadata,
    })),
  };
}

/**
 * HTTP 서버 생성. listen 은 호출자가 한다.
 * router 순서: 인증 → 라우팅.
 */
export function createConversionServer(config: ServerConfig): Server {
  const queue = config.queue;
  const secret = config.sharedSecret ?? process.env.CONVERSION_SHARED_SECRET ?? "";
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const hwpToMarkdown = config.hwpToMarkdown;
  const fetchSource: FetchSourceFn =
    config.fetchSource ??
    (async (sourceUrl: string) => {
      const r = await fetch(sourceUrl);
      if (!r.ok) throw new Error(`source download failed: HTTP ${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    });
  const maxSourceBytes = config.hwpMarkdownMaxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // healthcheck (인증 불필요).
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 인증: secret 설정된 경우에만 강제.
    if (secret.length > 0) {
      const provided = extractSecret(req);
      if (provided === null || !timingSafeEqual(provided, secret)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // POST /v1/conversion-jobs
    if (req.method === "POST" && path === "/v1/conversion-jobs") {
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        sendJson(res, 413, { error: err instanceof Error ? err.message : "body read failed" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const validated = validateJobRequest(parsed);
      if (!validated.ok) {
        sendJson(res, 400, { error: validated.reason });
        return;
      }
      const record = queue.enqueue(validated.value);
      if (record.cached) {
        // 캐시 히트: 즉시 succeeded/partial + artifacts 반환 (계획 4.1).
        sendJson(res, 200, {
          jobId: record.jobId,
          status: record.status,
          cached: true,
          artifacts: record.artifacts.map((a) => ({
            kind: a.kind,
            ...(a.page !== null ? { page: a.page } : {}),
            storageKey: a.storageKey,
            url: a.url,
            sha256: a.sha256,
            contentType: a.contentType,
            metadata: a.metadata,
          })),
        });
        return;
      }
      sendJson(res, 202, { jobId: record.jobId, status: record.status, cached: false });
      return;
    }

    // POST /v1/hwp-markdown — 동기 HWP→markdown (인제스트 위임용, 큐 미경유).
    // 변환은 어댑터 1회 호출(spawnSync)이라 짧게 이벤트 루프를 점유한다 — 작은 파일 텍스트 추출 용도.
    if (req.method === "POST" && path === "/v1/hwp-markdown") {
      if (!hwpToMarkdown) {
        sendJson(res, 503, { error: "hwp markdown converter not configured", code: "converter_unavailable" });
        return;
      }
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        sendJson(res, 413, { error: err instanceof Error ? err.message : "body read failed" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const validated = validateHwpMarkdownRequest(parsed);
      if (!validated.ok) {
        sendJson(res, 400, { error: validated.reason });
        return;
      }
      let body: Buffer;
      try {
        body = await fetchSource(validated.value.sourceObjectUrl);
      } catch (err) {
        sendJson(res, 502, {
          error: err instanceof Error ? err.message : "source download failed",
          code: "source_fetch_failed",
        });
        return;
      }
      if (body.length > maxSourceBytes) {
        sendJson(res, 413, {
          error: `source too large: ${body.length} bytes (max ${maxSourceBytes})`,
          code: "source_too_large",
        });
        return;
      }
      if (validated.value.sha256 && sha256Hex(body) !== validated.value.sha256) {
        sendJson(res, 409, { error: "source sha256 mismatch", code: "sha256_mismatch" });
        return;
      }
      try {
        const result = hwpToMarkdown({ filename: validated.value.filename, body });
        sendJson(res, 200, { markdown: result.markdown, converter: result.converter });
      } catch (err) {
        sendJson(res, 422, {
          error: err instanceof Error ? err.message : "conversion failed",
          code: "conversion_failed",
        });
      }
      return;
    }

    // GET /v1/conversion-jobs/:jobId(/artifacts)
    const jobMatch = path.match(/^\/v1\/conversion-jobs\/([^/]+)(\/artifacts)?$/);
    if (req.method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1] ?? "");
      const wantArtifacts = jobMatch[2] === "/artifacts";
      const body = wantArtifacts
        ? artifactsResponse(queue, jobId)
        : jobStatusResponse(queue, jobId);
      if (body === null) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }
}

/**
 * 프로덕션 부트스트랩 (CMD ["node","dist/server.js"]).
 * env 에서 R2 클라이언트/시크릿을 읽고 서버를 기동한다.
 */
export function bootstrapFromEnv(
  deps: { hwpToMarkdown?: HwpToMarkdownFn; hwpxConvert?: HwpxConvertFn } = {},
): Server {
  const storage: R2ObjectStorage | null = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new Error("R2 환경변수(R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET/BUCKET_URL) 누락");
  }
  const concurrency = Number(process.env.CONVERSION_CONCURRENCY ?? "2") || 2;
  const queue = new ConversionQueue({
    storage,
    concurrency,
    ...(deps.hwpToMarkdown ? { hwpToMarkdown: deps.hwpToMarkdown } : {}),
    ...(deps.hwpxConvert ? { hwpxConvert: deps.hwpxConvert } : {}),
    ...(process.env.CONVERSION_KEY_PREFIX ? { keyPrefix: process.env.CONVERSION_KEY_PREFIX } : {}),
  });
  // 동기 markdown 엔드포인트도 같은 어댑터를 쓴다 (미주입 시 503).
  return createConversionServer({
    queue,
    ...(deps.hwpToMarkdown ? { hwpToMarkdown: deps.hwpToMarkdown } : {}),
  });
}
