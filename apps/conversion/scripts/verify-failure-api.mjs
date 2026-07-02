#!/usr/bin/env node
// T9 (전 구간 API→큐→변환→R2) — 실패 경로 end-to-end 검증.
// 실제 HTTP 서버 기동 → POST job → 폴링 → GET status/artifacts → R2 부작용 확인.
// 실패 job 은 artifact 를 하나도 올리지 않아야 하고, 부분성공 job 은 성공한 artifact 만 올라가야 한다.
//
// 실행: node apps/conversion/scripts/verify-failure-api.mjs [--sdk /tmp/dk/node_modules]
// 전제: R2 자격증명(.env/.env.local), @aws-sdk/client-s3 (NODE_PATH 또는 --sdk).
//       업로드 키 프리픽스는 conversion-dev/ (검증용). 부분성공 artifact 는 검증 후 남을 수 있으나
//       원본 sha256 프리픽스로 격리되고 재실행 시 덮어써진다.
//
// 커버:
//   - 암호화 HWP        → status=failed, artifacts=[] , R2 업로드 0건
//   - 손상 HWP          → status=failed, artifacts=[]
//   - sha256 불일치      → status=failed (요청 sha != 실제 sha)
//   - 미지원 포맷        → status=failed
//   - 부분성공(텍스트없음)→ status=partial, artifacts=pdf+page_image(들) 만, markdown 없음
//   - 실패 job 재등록     → 캐시에 실패는 안 담기므로 cached:false 로 재시도됨(멱등 확인)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversionQueue, createR2ObjectStorage, sha256Hex } from "./convert-lib.mjs";
import { createConversionServer } from "./server-lib.mjs";
import { buildFailureFixtures } from "./failure-fixtures.mjs";

// 샌드박스: H2O 는 기본 프로필에 있음 → 워커별 프로필 격리를 켜지 않는다.
delete process.env.CONVERSION_LO_SHARED_H2O;

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
const sdkPath = sdkIdx >= 0 ? args[sdkIdx + 1] : process.env.CONVERSION_SDK_PATH ?? "/tmp/dk/node_modules";
const sdkRequire = createRequire(join(resolve(sdkPath), "noop.js"));

const SECRET = "dev-secret";
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY_PREFIX = "conversion-dev";
const H = (secret) => ({ "content-type": "application/json", "x-shared-secret": secret });

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

let uploadCount = 0;
function wrapStorageCounting(storage) {
  return {
    ...storage,
    async putObject(input) { uploadCount += 1; return storage.putObject(input); },
  };
}

async function pollTerminal(jobId) {
  let body;
  for (let i = 0; i < 240; i += 1) {
    const g = await fetch(`${BASE}/v1/conversion-jobs/${jobId}`, { headers: H(SECRET) });
    body = await g.json();
    if (["succeeded", "partial", "failed"].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 200));
  }
  return body;
}
async function getArtifacts(jobId) {
  const a = await fetch(`${BASE}/v1/conversion-jobs/${jobId}/artifacts`, { headers: H(SECRET) });
  return (await a.json()).artifacts ?? [];
}

let passed = 0, failedCount = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failedCount += 1; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
}

async function main() {
  const fx = buildFailureFixtures();
  const storage = wrapStorageCounting(makeStorage());
  // 실패 job 은 원본을 로컬 버퍼로 반환(네트워크 다운로드 대신). URL→body 디스패치.
  const byUrl = new Map();
  const register = (id, f) => { byUrl.set(`local://${id}`, f.body); return f; };
  const fetchSource = async (url) => {
    const b = byUrl.get(url);
    if (!b) throw new Error(`no body for ${url}`);
    return b;
  };
  const queue = new ConversionQueue({ storage, concurrency: 2, keyPrefix: KEY_PREFIX, fetchSource });
  const server = createConversionServer({ queue, sharedSecret: SECRET });
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[T9-e2e] 서버 기동 :${PORT}  (API→큐→변환→R2 실패 경로)\n`);

  let exitCode = 0;
  try {
    // ---- 실패 케이스들: status=failed, artifacts=[] , R2 업로드 0건 ----
    const failCases = [
      ["암호화 HWP", "enc-hwp", fx.encryptedHwp, (f) => sha256Hex(f.body)],
      ["손상 HWP", "corrupt", fx.corruptHwp, (f) => sha256Hex(f.body)],
      ["미지원 포맷", "unsupported", fx.unsupported, (f) => sha256Hex(f.body)],
      // sha256 불일치: 요청 sha 를 틀리게 넣는다(실제 body sha != 요청 sha).
      ["sha256 불일치", "shamis", fx.realHwp, () => "0".repeat(64)],
    ];

    for (const [label, id, f, shaFn] of failCases) {
      register(id, f);
      const uploadsBefore = uploadCount;
      const post = await fetch(`${BASE}/v1/conversion-jobs`, {
        method: "POST", headers: H(SECRET),
        body: JSON.stringify({
          jobId: `t9f-${id}`, source: "bizinfo", sourceId: "PBLN_T9F",
          filename: f.filename, sourceObjectUrl: `local://${id}`, sha256: shaFn(f),
        }),
      });
      const postBody = await post.json();
      const status = await pollTerminal(`t9f-${id}`);
      const artifacts = await getArtifacts(`t9f-${id}`);
      const uploads = uploadCount - uploadsBefore;
      console.log(`  [${label}] POST HTTP ${post.status} cached=${postBody.cached} → status=${status.status} error=${status.error} artifacts=${artifacts.length} R2업로드=${uploads} warnings=[${status.quality?.warnings?.join(",") ?? ""}]`);
      check(`${label} → failed`, status.status === "failed", `실제=${status.status}`);
      check(`${label} → artifacts 없음`, artifacts.length === 0, `실제=${artifacts.length}`);
      check(`${label} → R2 업로드 0건`, uploads === 0, `실제=${uploads}`);
    }

    // 암호화/미지원은 encrypted_source/unsupported_format warning 확인
    {
      const s = await pollTerminal("t9f-enc-hwp");
      check("암호화 HWP → warning encrypted_source", (s.quality?.warnings ?? []).includes("encrypted_source"));
      const u = await pollTerminal("t9f-unsupported");
      check("미지원 → warning unsupported_format", (u.quality?.warnings ?? []).includes("unsupported_format"));
      const sm = await pollTerminal("t9f-shamis");
      check("sha 불일치 → warning sha256_mismatch", (sm.quality?.warnings ?? []).includes("sha256_mismatch"));
    }

    // ---- 안전 상한 옵션 주입 (계획 11장): API→큐→convertDocument 전달 검증 ----
    // 타임아웃: 실HWP + sofficeTimeoutMs=1 → soffice 타임아웃으로 failed (수분 대기 없이 주입 검증)
    {
      register("timeout", fx.realHwp);
      const uploadsBefore = uploadCount;
      await fetch(`${BASE}/v1/conversion-jobs`, {
        method: "POST", headers: H(SECRET),
        body: JSON.stringify({
          jobId: "t9f-timeout", source: "bizinfo", sourceId: "PBLN_T9F",
          filename: fx.realHwp.filename, sourceObjectUrl: "local://timeout", sha256: sha256Hex(fx.realHwp.body),
          options: { sofficeTimeoutMs: 1 },
        }),
      });
      const status = await pollTerminal("t9f-timeout");
      const uploads = uploadCount - uploadsBefore;
      console.log(`  [타임아웃 주입] → status=${status.status} error=${status.error} R2업로드=${uploads}`);
      check("타임아웃 주입(API 경유) → failed", status.status === "failed", `실제=${status.status}`);
      check("타임아웃 주입 → R2 업로드 0건", uploads === 0, `실제=${uploads}`);
    }
    // 대용량 상한: 실HWP + maxBytes=1024 → oversize_source 로 failed
    {
      register("oversize", fx.realHwp);
      await fetch(`${BASE}/v1/conversion-jobs`, {
        method: "POST", headers: H(SECRET),
        body: JSON.stringify({
          jobId: "t9f-oversize", source: "bizinfo", sourceId: "PBLN_T9F",
          filename: fx.realHwp.filename, sourceObjectUrl: "local://oversize", sha256: sha256Hex(fx.realHwp.body),
          options: { maxBytes: 1024 },
        }),
      });
      const status = await pollTerminal("t9f-oversize");
      console.log(`  [대용량 상한 주입] → status=${status.status} warnings=[${status.quality?.warnings?.join(",") ?? ""}]`);
      check("대용량 상한 주입(API 경유) → failed", status.status === "failed", `실제=${status.status}`);
      check("대용량 상한 주입 → warning oversize_source", (status.quality?.warnings ?? []).includes("oversize_source"));
    }

    // ---- 부분성공: 텍스트 없는 PDF → partial, pdf+page_image 만 업로드, markdown 없음 ----
    {
      register("textless", fx.textlessPdf);
      const uploadsBefore = uploadCount;
      const sha = sha256Hex(fx.textlessPdf.body);
      const post = await fetch(`${BASE}/v1/conversion-jobs`, {
        method: "POST", headers: H(SECRET),
        body: JSON.stringify({
          jobId: "t9f-textless", source: "bizinfo", sourceId: "PBLN_T9F",
          filename: fx.textlessPdf.filename, sourceObjectUrl: "local://textless", sha256: sha,
        }),
      });
      const postBody = await post.json();
      const status = await pollTerminal("t9f-textless");
      const artifacts = await getArtifacts("t9f-textless");
      const uploads = uploadCount - uploadsBefore;
      const kinds = artifacts.map((a) => a.kind);
      console.log(`  [부분성공(텍스트없음)] cached=${postBody.cached} status=${status.status} artifacts=[${kinds.join(",")}] R2업로드=${uploads}`);
      check("부분성공 → status=partial", status.status === "partial", `실제=${status.status}`);
      check("부분성공 → pdf artifact 존재", kinds.includes("pdf"));
      check("부분성공 → page_image artifact 존재", kinds.includes("page_image"));
      check("부분성공 → markdown artifact 없음", !kinds.includes("markdown"));
      check("부분성공 → 업로드 건수 == artifacts 건수", uploads === artifacts.length, `업로드=${uploads} artifacts=${artifacts.length}`);

      // R2 실제 존재 확인(pdf 1건 GetObject).
      const pdfArt = artifacts.find((a) => a.kind === "pdf");
      if (pdfArt) {
        try {
          const r = await storage.getObjectText(pdfArt.storageKey);
          check("부분성공 → pdf artifact R2 존재", Buffer.byteLength(r, "utf8") > 0 || true); // 존재하면 예외 없음
        } catch (e) {
          check("부분성공 → pdf artifact R2 존재", false, e?.message);
        }
      }
    }

    // ---- 멱등/재시도: 실패 job 은 캐시에 담기지 않으므로 재등록 시 cached:false 로 다시 처리 ----
    {
      register("enc-hwp", fx.encryptedHwp);
      const post = await fetch(`${BASE}/v1/conversion-jobs`, {
        method: "POST", headers: H(SECRET),
        body: JSON.stringify({
          jobId: "t9f-enc-hwp-retry", source: "bizinfo", sourceId: "PBLN_T9F",
          filename: fx.encryptedHwp.filename, sourceObjectUrl: "local://enc-hwp", sha256: sha256Hex(fx.encryptedHwp.body),
        }),
      });
      const postBody = await post.json();
      const status = await pollTerminal("t9f-enc-hwp-retry");
      check("실패 job 재등록 → cached:false (재시도)", postBody.cached === false, `cached=${postBody.cached}`);
      check("실패 job 재등록 → 다시 failed", status.status === "failed");
    }

    console.log(`\n[T9-e2e] 통과 ${passed} / 실패 ${failedCount}`);
    if (failedCount > 0) exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
