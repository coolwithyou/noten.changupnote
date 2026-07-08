#!/usr/bin/env node
// hwp2hwpx 트랙 Phase 3 — 배포된 Cloud Run 변환 서버에서 hwpx sibling artifact 생성 원격 실증.
//
// smoke-remote.mjs(T10) 흐름을 복제하되 ① requestedArtifacts 에 "hwpx" 포함
// ② kind="hwpx" artifact 를 전량 다운로드해 PK 시그니처 + 첫 엔트리 mimetype STORE 를 단정한다.
//
// 사용: node scripts/spike/hwp2hwpx/remote-hwpx-probe.mjs [seedPath]
//   - env: CONVERSION_SERVER_URL, CONVERSION_SHARED_SECRET, R2_* (.env/.env.local 자동 로드)
//   - 시크릿은 절대 출력하지 않는다. R2 키 프리픽스는 conversion-dev/ 관례.

import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CONV_SCRIPTS = join(REPO_ROOT, "apps/conversion/scripts");
const { createR2ObjectStorage, sha256Hex } = await import(
  join(CONV_SCRIPTS, "convert-lib.mjs")
);
const sdkRequire = createRequire(join(CONV_SCRIPTS, "convert-lib.mjs"));

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

const serviceUrl = (process.env.CONVERSION_SERVER_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.CONVERSION_SHARED_SECRET?.trim();
if (!serviceUrl || !SECRET) {
  console.error("CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET 필요");
  process.exit(2);
}

function r2Config() {
  const cfg = {
    accountId: process.env.R2_ACCOUNT_ID?.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
    bucket: process.env.R2_BUCKET?.trim(),
    publicBaseUrl: process.env.R2_BUCKET_URL?.trim(),
  };
  for (const k of Object.keys(cfg)) {
    if (!cfg[k]) { console.error(`R2 env 누락: ${k}`); process.exit(2); }
  }
  return cfg;
}

// SigV4 presigned GET — smoke-remote.mjs 와 동일 구현.
function awsUriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of Buffer.from(str, "utf8")) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) ||
        c === "-" || c === "_" || c === "." || c === "~") out += c;
    else if (c === "/") out += encodeSlash ? "%2F" : "/";
    else out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();
const sha256hexStr = (data) => createHash("sha256").update(data, "utf8").digest("hex");

function presignGet(cfg, key, expires = 3600) {
  const url = new URL(cfg.publicBaseUrl.startsWith("http") ? cfg.publicBaseUrl : `https://${cfg.publicBaseUrl}`);
  const host = url.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = "/" + key.split("/").map((s) => awsUriEncode(s, false)).join("/");
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${credScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k])}`).join("&");
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256hexStr(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const H = { "content-type": "application/json", "x-shared-secret": SECRET };

// 첫 로컬 파일 헤더가 mimetype·STORE(method=0)·application/hwp+zip 인지 단정.
function assertHwpxBytes(buf) {
  const checks = [];
  checks.push(["PK 시그니처", buf.readUInt32LE(0) === 0x04034b50]);
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const name = buf.subarray(30, 30 + nameLen).toString("utf8");
  checks.push(["첫 엔트리 mimetype", name === "mimetype"]);
  checks.push(["mimetype STORE(method=0)", method === 0]);
  const content = buf.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + 19).toString("utf8");
  checks.push(["내용 application/hwp+zip", content === "application/hwp+zip"]);
  return checks;
}

async function main() {
  const seedPath = process.argv[2] ??
    "spike-samples/files/26_11d604b4b6353493-참여_신청서._개인정보_수집_및_이용_동의서_양식.hwp";
  const filename = basename(seedPath);
  const body = readFileSync(join(REPO_ROOT, seedPath));
  const sha = sha256Hex(body);
  const cfg = r2Config();
  const storage = createR2ObjectStorage(cfg, sdkRequire);

  const srcKey = `conversion-dev/hwp2hwpx-probe/${sha.slice(0, 16)}-${filename}`;
  await storage.putObject({ key: srcKey, body, contentType: "application/octet-stream" });
  const sourceObjectUrl = presignGet(cfg, srcKey);

  const jobId = `hwp2hwpx-probe-${sha.slice(0, 12)}-${Date.now()}`;
  const post = await fetch(`${serviceUrl}/v1/conversion-jobs`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      jobId, source: "bizinfo", sourceId: "HWP2HWPX_PROBE", filename,
      sourceObjectUrl, sha256: sha,
      requestedArtifacts: ["pdf", "page_images", "markdown", "hwpx"],
      options: { pageImageDpi: 220 },
    }),
  });
  const postBody = await post.json();
  console.log(`[post] HTTP ${post.status} cached=${postBody.cached ?? "?"} status=${postBody.status ?? "?"}`);
  if (postBody.cached === true) {
    console.log("[warn] 캐시 히트 — 이 sha 는 hwpx 미요청 시절 결과일 수 있음. 다른 샘플로 재시도 요망.");
  }

  let st = postBody;
  for (let i = 0; i < 150 && !["succeeded", "partial", "failed"].includes(st.status); i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const g = await fetch(`${serviceUrl}/v1/conversion-jobs/${encodeURIComponent(jobId)}`, { headers: H });
    st = await g.json();
  }
  console.log(`[job] status=${st.status} quality=${st.quality?.status ?? "?"} warnings=${JSON.stringify(st.quality?.warnings ?? [])} error=${st.error ?? "없음"}`);

  const art = await fetch(`${serviceUrl}/v1/conversion-jobs/${encodeURIComponent(jobId)}/artifacts`, { headers: H });
  const artBody = await art.json();
  const kinds = (artBody.artifacts ?? []).map((a) => a.kind);
  console.log(`[artifacts] ${artBody.artifacts?.length ?? 0}건 kinds=${JSON.stringify([...new Set(kinds)])}`);

  const hwpx = (artBody.artifacts ?? []).find((a) => a.kind === "hwpx");
  if (!hwpx) {
    console.log("❌ kind=hwpx artifact 없음");
    process.exit(1);
  }
  const r = await fetch(presignGet(cfg, hwpx.storageKey));
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(`[hwpx] storageKey=${hwpx.storageKey} bytes=${buf.length} contentType=${hwpx.contentType} metadata=${JSON.stringify(hwpx.metadata ?? {})}`);
  let ok = true;
  for (const [label, pass] of assertHwpxBytes(buf)) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "✅ 원격 hwpx sibling 생성 실증 PASS" : "❌ 바이트 단정 실패");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
