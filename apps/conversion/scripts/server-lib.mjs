// HTTP 서버 미러 (src/server.ts). 검증용 plain-node. src/server.ts 가 정본.
// node 내장 http. 인증: x-shared-secret / Bearer. env CONVERSION_SHARED_SECRET.

import { createServer } from "node:http";

const DEFAULT_MAX_BODY = 256 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
function extractSecret(req) {
  const header = req.headers["x-shared-secret"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function validateJobRequest(v) {
  if (typeof v !== "object" || v === null) return { ok: false, reason: "body must be an object" };
  const required = ["jobId", "source", "sourceId", "filename", "sourceObjectUrl", "sha256"];
  for (const k of required) {
    if (typeof v[k] !== "string" || v[k].length === 0) return { ok: false, reason: `missing or invalid field: ${k}` };
  }
  const dpiRaw = v.options?.pageImageDpi;
  const dpi = dpiRaw === 300 ? 300 : dpiRaw === 220 ? 220 : undefined;
  const posInt = (x) => (typeof x === "number" && Number.isInteger(x) && x > 0 ? x : undefined);
  const sofficeTimeoutMs = posInt(v.options?.sofficeTimeoutMs);
  const maxBytes = posInt(v.options?.maxBytes);
  const maxPages = posInt(v.options?.maxPages);
  const options = {
    ...(dpi !== undefined ? { pageImageDpi: dpi } : {}),
    ...(sofficeTimeoutMs !== undefined ? { sofficeTimeoutMs } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  };
  const request = {
    jobId: v.jobId, source: v.source, sourceId: v.sourceId, filename: v.filename,
    sourceObjectUrl: v.sourceObjectUrl, sha256: v.sha256,
    ...(typeof v.surfaceId === "string" ? { surfaceId: v.surfaceId } : {}),
    ...(Array.isArray(v.requestedArtifacts) ? { requestedArtifacts: v.requestedArtifacts.filter((x) => typeof x === "string") } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
  return { ok: true, value: request };
}
function artifactView(a) {
  return {
    kind: a.kind, ...(a.page !== null ? { page: a.page } : {}),
    storageKey: a.storageKey, url: a.url, sha256: a.sha256, contentType: a.contentType, metadata: a.metadata,
  };
}
function jobStatusResponse(queue, jobId) {
  const rec = queue.get(jobId);
  if (!rec) return null;
  return {
    jobId: rec.jobId, status: rec.status, converterVersion: rec.converterVersion, cached: rec.cached,
    quality: rec.quality ? {
      renderEngine: rec.quality.renderEngine, pdfRendered: rec.quality.pdfRendered,
      pageImagesRendered: rec.quality.pageImagesRendered, textExtracted: rec.quality.textExtracted,
      pageCount: rec.quality.pageCount, pageImageDpi: rec.quality.pageImageDpi,
      textCoverage: rec.quality.textCoverage, warnings: rec.quality.warnings, status: rec.quality.status,
    } : null,
    error: rec.error, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
  };
}
function artifactsResponse(queue, jobId) {
  const rec = queue.get(jobId);
  if (!rec) return null;
  return { jobId: rec.jobId, artifacts: rec.artifacts.map(artifactView) };
}

export function createConversionServer({ queue, sharedSecret, maxBodyBytes }) {
  const secret = sharedSecret ?? process.env.CONVERSION_SHARED_SECRET ?? "";
  const maxBody = maxBodyBytes ?? DEFAULT_MAX_BODY;
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: err?.message ?? String(err) }));
  });
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/healthz") { sendJson(res, 200, { ok: true }); return; }
    if (secret.length > 0) {
      const provided = extractSecret(req);
      if (provided === null || !timingSafeEqual(provided, secret)) { sendJson(res, 401, { error: "unauthorized" }); return; }
    }
    if (req.method === "POST" && path === "/v1/conversion-jobs") {
      let raw;
      try { raw = await readBody(req, maxBody); }
      catch (err) { sendJson(res, 413, { error: err?.message ?? "body read failed" }); return; }
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8") || "{}"); }
      catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
      const validated = validateJobRequest(parsed);
      if (!validated.ok) { sendJson(res, 400, { error: validated.reason }); return; }
      const record = queue.enqueue(validated.value);
      if (record.cached) {
        sendJson(res, 200, { jobId: record.jobId, status: record.status, cached: true, artifacts: record.artifacts.map(artifactView) });
        return;
      }
      sendJson(res, 202, { jobId: record.jobId, status: record.status, cached: false });
      return;
    }
    const jobMatch = path.match(/^\/v1\/conversion-jobs\/([^/]+)(\/artifacts)?$/);
    if (req.method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1] ?? "");
      const body = jobMatch[2] === "/artifacts" ? artifactsResponse(queue, jobId) : jobStatusResponse(queue, jobId);
      if (body === null) { sendJson(res, 404, { error: "job not found" }); return; }
      sendJson(res, 200, body);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }
  return server;
}
