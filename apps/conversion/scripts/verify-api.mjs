#!/usr/bin/env node
// T6 검증: 한 프로세스 안에서 서버 기동 → POST(job 등록) → 폴링 → artifacts 조회
//           → 동일 파일 재등록 시 cached:true → 종료. 잘못된 secret 은 401.
// 실행: node apps/conversion/scripts/verify-api.mjs <file> [--sdk /tmp/dk/node_modules]
//
// R2 자격증명은 저장소 루트 .env / .env.local 의 R2_* 를 로드하며 업로드는 conversion-dev/ 프리픽스.
// 원본 다운로드는 로컬 버퍼로 대체(fetchSource) — 네트워크 왕복은 API 3종에만 사용.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversionQueue, createR2ObjectStorage, sha256Hex } from "./convert-lib.mjs";
import { createConversionServer } from "./server-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function loadEnv(file) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* noop */ }
}
loadEnv(join(REPO_ROOT, ".env"));
loadEnv(join(REPO_ROOT, ".env.local"));

const args = process.argv.slice(2);
const sdkIdx = args.indexOf("--sdk");
const sdkPath = sdkIdx >= 0 ? args[sdkIdx + 1] : "/tmp/dk/node_modules";
const inputPath = args.find((a) => !a.startsWith("--") && a !== sdkPath);
if (!inputPath) { console.error("사용법: node verify-api.mjs <file> [--sdk <node_modules>]"); process.exit(1); }
const sdkRequire = createRequire(join(resolve(sdkPath), "noop.js"));

const SECRET = "dev-secret";
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY_PREFIX = "conversion-dev";

function makeStorage() {
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
  return createR2ObjectStorage(cfg, sdkRequire);
}

const H = (secret) => ({ "content-type": "application/json", "x-shared-secret": secret });

async function main() {
  const body = readFileSync(inputPath);
  const filename = basename(inputPath);
  const sha = sha256Hex(body);
  const storage = makeStorage();

  const queue = new ConversionQueue({
    storage, concurrency: 2, keyPrefix: KEY_PREFIX,
    fetchSource: async () => body, // API 왕복만 검증, 원본 다운로드는 로컬 버퍼
  });
  const server = createConversionServer({ queue, sharedSecret: SECRET });
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[T6] 서버 기동 :${PORT}  입력=${filename} sha=${sha.slice(0, 16)}...`);

  let exitCode = 0;
  try {
    // 0) 잘못된 secret → 401
    const bad = await fetch(`${BASE}/v1/conversion-jobs`, {
      method: "POST", headers: H("WRONG"),
      body: JSON.stringify({ jobId: "x", source: "bizinfo", sourceId: "s", filename, sourceObjectUrl: "local://x", sha256: sha }),
    });
    console.log(`  [auth] 잘못된 secret → HTTP ${bad.status} (401 기대) ${bad.status === 401 ? "OK" : "FAIL"}`);
    if (bad.status !== 401) exitCode = 1;

    // 1) POST job 등록
    const jobId = "t6-job-1";
    const post1 = await fetch(`${BASE}/v1/conversion-jobs`, {
      method: "POST", headers: H(SECRET),
      body: JSON.stringify({
        jobId, source: "bizinfo", sourceId: "PBLN_T6", filename,
        sourceObjectUrl: "local://source", sha256: sha,
        requestedArtifacts: ["pdf", "page_images", "markdown"], options: { pageImageDpi: 220 },
      }),
    });
    const post1Body = await post1.json();
    console.log(`  [POST] HTTP ${post1.status} → ${JSON.stringify(post1Body)} (202 queued cached:false 기대)`);
    if (post1.status !== 202 || post1Body.cached !== false) exitCode = 1;

    // 2) 폴링 (succeeded/partial/failed 까지)
    let statusBody;
    for (let i = 0; i < 120; i += 1) {
      const g = await fetch(`${BASE}/v1/conversion-jobs/${jobId}`, { headers: H(SECRET) });
      statusBody = await g.json();
      if (["succeeded", "partial", "failed"].includes(statusBody.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`  [GET status] status=${statusBody.status} quality.status=${statusBody.quality?.status} pages=${statusBody.quality?.pageCount} textCoverage=${statusBody.quality?.textCoverage?.toFixed?.(3)} warnings=[${statusBody.quality?.warnings?.join(",")}]`);
    if (!["succeeded", "partial"].includes(statusBody.status)) {
      console.log(`  [WARN] job 이 succeeded/partial 이 아님 (error=${statusBody.error}). H2O 미설치면 HWP/HWPX 는 실패할 수 있음.`);
      exitCode = 1;
    }

    // 3) artifacts 조회
    const art = await fetch(`${BASE}/v1/conversion-jobs/${jobId}/artifacts`, { headers: H(SECRET) });
    const artBody = await art.json();
    console.log(`  [GET artifacts] HTTP ${art.status} count=${artBody.artifacts.length}`);
    for (const a of artBody.artifacts) {
      console.log(`      - [${a.kind}${a.page !== undefined ? " p" + a.page : ""}] ${a.storageKey}`);
    }
    // 업로드 확인: 인증 GetObject 로 오브젝트 존재 확인 (markdown 1건).
    // (R2_BUCKET_URL 은 S3 API 엔드포인트라 미인증 public GET 은 400 — 저장소 코드도 getObjectText 로 검증.)
    const mdArt = artBody.artifacts.find((a) => a.kind === "markdown");
    if (mdArt) {
      const text = await storage.getObjectText(mdArt.storageKey);
      const present = Buffer.byteLength(text, "utf8") > 0;
      console.log(`  [artifact GetObject] markdown R2 존재=${present ? "OK" : "FAIL"} (${Buffer.byteLength(text, "utf8")} bytes)`);
      if (!present) exitCode = 1;
    }

    // 4) 동일 파일 재등록 → cached:true
    const post2 = await fetch(`${BASE}/v1/conversion-jobs`, {
      method: "POST", headers: H(SECRET),
      body: JSON.stringify({ jobId: "t6-job-2", source: "bizinfo", sourceId: "PBLN_T6", filename, sourceObjectUrl: "local://source", sha256: sha }),
    });
    const post2Body = await post2.json();
    console.log(`  [POST 재등록] HTTP ${post2.status} → status=${post2Body.status} cached=${post2Body.cached} artifacts=${post2Body.artifacts?.length ?? 0} (cached:true 기대)`);
    if (post2Body.cached !== true) exitCode = 1;

    // 5) 없는 job → 404
    const nf = await fetch(`${BASE}/v1/conversion-jobs/nope`, { headers: H(SECRET) });
    console.log(`  [GET 없는 job] HTTP ${nf.status} (404 기대) ${nf.status === 404 ? "OK" : "FAIL"}`);
    if (nf.status !== 404) exitCode = 1;

    console.log(`\n[T6] ${exitCode === 0 ? "PASS" : "FAIL"}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
