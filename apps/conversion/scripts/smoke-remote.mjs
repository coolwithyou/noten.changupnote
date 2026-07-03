#!/usr/bin/env node
// T10 원격 스모크: 배포된 변환 서버(Cloud Run)를 시드 문서로 왕복 검증하는 재사용 운영 도구.
// verify-api.mjs(로컬 인프로세스 검증) 패턴을 원격 서비스 URL 대상으로 옮긴 것.
//
// 흐름(시드 1건당):
//   1) 원본을 R2(conversion-dev/smoke-source/...)에 업로드
//   2) 그 오브젝트의 presigned GET URL 을 만들어 sourceObjectUrl 로 서버에 전달
//      (서버는 이 URL 을 직접 내려받는다. R2 S3 엔드포인트는 미인증 GET 이 막혀 있으므로 presign 필수)
//   3) POST /v1/conversion-jobs 등록 → 폴링(succeeded/partial/failed) → artifacts 목록
//   4) 각 artifact 를 R2 인증(presigned) GET 으로 실재 확인
//   5) 동일 sha256 재등록 → cached:true 확인
// 그리고 전역으로 도달성(GET / → 앱 401)과 잘못된 secret 401 을 확인한다.
// (/healthz 는 run.app URL 에서 Google 프런트엔드가 가로채므로 원격 확인에 쓸 수 없다)
//
// 사용법:
//   CONVERSION_SHARED_SECRET=... \
//   node apps/conversion/scripts/smoke-remote.mjs <serviceUrl> [seed...] [--sdk <node_modules>] [--key-prefix conversion-dev]
//   - serviceUrl 미지정 시 env CONVERSION_SERVER_URL 사용.
//   - seed 미지정 시 내장 기본 시드 5건(HWP2·HWPX1·PDF1·DOCX1).
//   - 공유 시크릿은 env CONVERSION_SHARED_SECRET (gcloud secrets versions access 로 주입). 절대 출력하지 않는다.
//   - R2 자격증명(R2_*)은 저장소 루트 .env/.env.local 에서 자동 로드.

import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createR2ObjectStorage, sha256Hex } from "./convert-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

// ── .env 로드 (verify-api.mjs 와 동일 규칙) ────────────────────────────────
function loadEnv(file) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* noop */ }
}
loadEnv(join(REPO_ROOT, ".env"));
loadEnv(join(REPO_ROOT, ".env.local"));

// ── 인자 파싱 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const sdkPath = takeFlag("--sdk") ?? resolve(__dirname, "../node_modules");
const keyPrefix = takeFlag("--key-prefix") ?? "conversion-dev";
const positional = argv.filter((a) => !a.startsWith("--"));

const serviceUrl = (positional.shift() ?? process.env.CONVERSION_SERVER_URL ?? "").replace(/\/+$/, "");
if (!serviceUrl) {
  console.error("서비스 URL 이 필요합니다: 인자 또는 env CONVERSION_SERVER_URL");
  process.exit(1);
}
const SECRET = process.env.CONVERSION_SHARED_SECRET?.trim();
if (!SECRET) {
  console.error("env CONVERSION_SHARED_SECRET 이 필요합니다 (gcloud secrets versions access 로 주입).");
  process.exit(2);
}

// 기본 시드: spike-samples(HWP/HWPX) + spike-samples3(PDF/DOCX).
const DEFAULT_SEEDS = [
  "spike-samples/files/09_cac17c25b2d8e9ad-_서식1-5_일경험_참여기업_신청서류_신청서확인서협약서서약서운영계획서_.hwp",
  "spike-samples/files/10_460724c1b589c540-_검단지역__신청서류_지원신청서.사업계획서.개인정보이용및제공동의서_.hwp",
  "spike-samples/files/01_6531c283efa40421-융자신청서_사업계획서_및_개인정보수집동의서_.hwpx",
  "spike-samples3/files/pdf02.pdf",
  "spike-samples3/files/docx02.docx",
].map((p) => (p.startsWith("/") ? p : join(REPO_ROOT, p)));
const seeds = positional.length > 0 ? positional.map((p) => (p.startsWith("/") ? p : resolve(p))) : DEFAULT_SEEDS;

const sdkRequire = createRequire(join(resolve(sdkPath), "noop.js"));

// ── R2 설정 ───────────────────────────────────────────────────────────────
function r2Config() {
  const cfg = {
    accountId: process.env.R2_ACCOUNT_ID?.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
    bucket: process.env.R2_BUCKET?.trim(),
    publicBaseUrl: process.env.R2_BUCKET_URL?.trim(),
    ...(process.env.R2_ENDPOINT?.trim() ? { endpoint: process.env.R2_ENDPOINT.trim() } : {}),
  };
  for (const k of ["accountId", "accessKeyId", "secretAccessKey", "bucket", "publicBaseUrl"]) {
    if (!cfg[k]) { console.error(`R2 env 누락: ${k}`); process.exit(2); }
  }
  return cfg;
}

// ── SigV4 presigned GET (R2, virtual-hosted style) ────────────────────────
// R2_BUCKET_URL(=publicBaseUrl) 이 가리키는 호스트로 오브젝트를 서명한다.
// putObject 가 반환하는 공개 URL 과 동일 호스트/키를 대상으로 하므로 오브젝트가 일치한다.
function awsUriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of Buffer.from(str, "utf8")) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) ||
        c === "-" || c === "_" || c === "." || c === "~") {
      out += c;
    } else if (c === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}
function hmac(key, data) { return createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256hex(data) { return createHash("sha256").update(data, "utf8").digest("hex"); }

function presignGet(cfg, key, expires = 3600) {
  const url = new URL(cfg.publicBaseUrl.startsWith("http") ? cfg.publicBaseUrl : `https://${cfg.publicBaseUrl}`);
  const host = url.host;
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = "/" + key.split("/").map((s) => awsUriEncode(s, false)).join("/");
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${credScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k])}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    "GET", canonicalUri, canonicalQuery, canonicalHeaders, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, credScope, sha256hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── 포맷 판정 ─────────────────────────────────────────────────────────────
function detectFormat(filename) {
  const ext = filename.toLowerCase().split(".").pop();
  return ["hwp", "hwpx", "pdf", "docx"].includes(ext) ? ext : "unknown";
}

const H = (secret) => ({ "content-type": "application/json", "x-shared-secret": secret });

async function pollStatus(jobId) {
  let body;
  for (let i = 0; i < 120; i += 1) {
    const g = await fetch(`${serviceUrl}/v1/conversion-jobs/${encodeURIComponent(jobId)}`, { headers: H(SECRET) });
    body = await g.json();
    if (["succeeded", "partial", "failed"].includes(body.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return body;
}

async function main() {
  const cfg = r2Config();
  const storage = createR2ObjectStorage(cfg, sdkRequire);
  let exitCode = 0;
  const results = [];

  // 전역 A) 도달성. 주의: run.app 기본 URL 에서 /healthz 는 Google 프런트엔드가
  // 가로채 404 를 반환한다 (컨테이너 미도달, 2026-07-03 T10 배포에서 확인).
  // 대신 미인증 GET / 가 앱의 401 {"error":"unauthorized"} 를 돌려주는 것으로
  // "컨테이너 기동 + 앱 인증 계층 동작"을 확인한다.
  const hz = await fetch(`${serviceUrl}/`);
  const hzBody = await hz.text();
  const hzOk = hz.status === 401 && hzBody.includes("unauthorized");
  console.log(`[reach] GET / → HTTP ${hz.status} ${hzOk ? "OK(앱 401)" : `FAIL body=${hzBody.slice(0, 120)}`}`);
  if (!hzOk) exitCode = 1;

  // 전역 B) 잘못된 secret → 401
  const bad = await fetch(`${serviceUrl}/v1/conversion-jobs`, {
    method: "POST",
    headers: H("WRONG-SECRET"),
    body: JSON.stringify({ jobId: "smoke-auth", source: "bizinfo", sourceId: "s", filename: "x.pdf", sourceObjectUrl: "https://x", sha256: "0".repeat(64) }),
  });
  const authOk = bad.status === 401;
  console.log(`[auth] 잘못된 secret → HTTP ${bad.status} ${authOk ? "OK(401)" : "FAIL"}`);
  if (!authOk) exitCode = 1;

  const ts = Date.now();
  for (const seedPath of seeds) {
    const filename = basename(seedPath);
    const format = detectFormat(filename);
    const rec = { filename, format, status: "?", qualityStatus: "?", artifactCount: 0, artifactsVerified: 0, cached: null, error: null };
    try {
      const body = readFileSync(seedPath);
      const sha = sha256Hex(body);
      const sha16 = sha.slice(0, 16);

      // 1) 원본을 R2 conversion-dev/smoke-source/ 에 업로드
      const srcKey = `${keyPrefix}/smoke-source/${sha16}-${filename}`;
      await storage.putObject({ key: srcKey, body, contentType: "application/octet-stream" });
      const sourceObjectUrl = presignGet(cfg, srcKey);

      // 2) POST 등록
      const jobId = `smoke-${sha16}-${ts}`;
      const sourceId = `SMOKE_${format.toUpperCase()}`;
      const post = await fetch(`${serviceUrl}/v1/conversion-jobs`, {
        method: "POST",
        headers: H(SECRET),
        body: JSON.stringify({
          jobId, source: "bizinfo", sourceId, filename,
          sourceObjectUrl, sha256: sha,
          requestedArtifacts: ["pdf", "page_images", "markdown"],
          options: { pageImageDpi: 220 },
        }),
      });
      const postBody = await post.json();
      if (postBody.cached === true) {
        // 이미 캐시에 있으면(이전 실행 잔재) 바로 성공 처리로 간주하고 상태 조회 생략 가능하지만
        // 일관성을 위해 status 폴링을 건너뛰고 postBody 를 사용한다.
        rec.status = postBody.status;
      }

      // 3) 폴링
      const st = await pollStatus(jobId);
      rec.status = st.status;
      rec.qualityStatus = st.quality?.status ?? "?";
      rec.error = st.error ?? null;
      const pageCount = st.quality?.pageCount;
      const textCoverage = st.quality?.textCoverage;
      const warnings = st.quality?.warnings ?? [];

      // 4) artifacts 목록
      const art = await fetch(`${serviceUrl}/v1/conversion-jobs/${encodeURIComponent(jobId)}/artifacts`, { headers: H(SECRET) });
      const artBody = await art.json();
      rec.artifactCount = artBody.artifacts?.length ?? 0;

      // 5) 각 artifact 를 R2 presigned GET(Range 0-0)으로 실재 확인
      for (const a of artBody.artifacts ?? []) {
        const url = presignGet(cfg, a.storageKey);
        const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
        if (r.status === 200 || r.status === 206) rec.artifactsVerified += 1;
        else console.log(`      [artifact MISSING] ${a.storageKey} → HTTP ${r.status}`);
        // 응답 바디를 소비해 소켓을 닫는다
        await r.arrayBuffer().catch(() => {});
      }

      // 6) 동일 sha256 재등록 → cached:true
      const post2 = await fetch(`${serviceUrl}/v1/conversion-jobs`, {
        method: "POST",
        headers: H(SECRET),
        body: JSON.stringify({ jobId: `${jobId}-recache`, source: "bizinfo", sourceId, filename, sourceObjectUrl, sha256: sha }),
      });
      const post2Body = await post2.json();
      rec.cached = post2Body.cached === true;

      const okSeed = ["succeeded", "partial"].includes(rec.status) && rec.artifactCount > 0 && rec.artifactsVerified === rec.artifactCount && rec.cached === true;
      if (!okSeed) exitCode = 1;
      console.log(
        `[${format}] ${filename}\n` +
        `    status=${rec.status} quality.status=${rec.qualityStatus} pages=${pageCount} textCoverage=${typeof textCoverage === "number" ? textCoverage.toFixed(3) : textCoverage} warnings=[${warnings.join(",")}]\n` +
        `    artifacts=${rec.artifactCount} verifiedInR2=${rec.artifactsVerified} recache.cached=${rec.cached} ${okSeed ? "OK" : "FAIL"}` +
        (rec.error ? `\n    error=${rec.error}` : ""),
      );
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      exitCode = 1;
      console.log(`[${format}] ${filename} EXCEPTION ${rec.error}`);
    }
    results.push(rec);
  }

  console.log("\n=== 요약 ===");
  console.log(JSON.stringify(results, null, 2));
  console.log(`\n[SMOKE] ${exitCode === 0 ? "PASS" : "FAIL"}  (reach=${hzOk} auth401=${authOk})`);
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
