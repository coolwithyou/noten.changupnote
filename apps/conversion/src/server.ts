// T6: HTTP API 3종 (계획 4장) — node 내장 http 모듈.
//   POST /v1/conversion-jobs            job 등록 (비동기). 캐시 히트면 즉시 succeeded.
//   GET  /v1/conversion-jobs/:jobId     상태 폴링.
//   GET  /v1/conversion-jobs/:jobId/artifacts   artifact 목록.
// 인증: shared secret 헤더 (x-shared-secret 또는 Authorization: Bearer). env CONVERSION_SHARED_SECRET.
//
// 웹앱이 서버-투-서버로만 호출한다 (공개 노출 안 함).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConversionQueue, type ConversionJobRequest } from "./queue.js";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "./storage.js";
import type { HwpToMarkdownFn } from "./convert-document.js";

export interface ServerConfig {
  queue: ConversionQueue;
  /** shared secret. 미지정 시 env CONVERSION_SHARED_SECRET. 비면 인증 비활성(경고). */
  sharedSecret?: string;
  /** 요청 본문 최대 바이트 (기본 256KB — 메타데이터만 받으므로 작다). */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 256 * 1024;

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
  const dpiRaw = (o.options as Record<string, unknown> | undefined)?.pageImageDpi;
  const dpi = dpiRaw === 300 ? 300 : dpiRaw === 220 ? 220 : undefined;
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
    ...(dpi !== undefined ? { options: { pageImageDpi: dpi } } : {}),
  };
  return { ok: true, value: request };
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
export function bootstrapFromEnv(deps: { hwpToMarkdown?: HwpToMarkdownFn } = {}): Server {
  const storage: R2ObjectStorage | null = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new Error("R2 환경변수(R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET/BUCKET_URL) 누락");
  }
  const concurrency = Number(process.env.CONVERSION_CONCURRENCY ?? "2") || 2;
  const queue = new ConversionQueue({
    storage,
    concurrency,
    ...(deps.hwpToMarkdown ? { hwpToMarkdown: deps.hwpToMarkdown } : {}),
    ...(process.env.CONVERSION_KEY_PREFIX ? { keyPrefix: process.env.CONVERSION_KEY_PREFIX } : {}),
  });
  return createConversionServer({ queue });
}
