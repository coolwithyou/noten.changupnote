#!/usr/bin/env node
// T4 검증: 변환 → R2 업로드 → 공개 URL 확인 → 동일 sha256 재실행 시 캐시 스킵.
// 실행: node apps/conversion/scripts/verify-storage.mjs <file> [--sdk /tmp/dk/node_modules]
//
// R2 자격증명은 저장소 루트 .env / .env.local 의 R2_* 를 로드한다.
// 업로드 key 프리픽스는 conversion-dev/ (삭제 불가 환경, 검증 전용 격리).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConversionQueue,
  buildStorageKey,
  cacheKey,
  createR2ObjectStorage,
  uploadArtifacts,
  convertDocument,
  CONVERTER_VERSION,
  sha256Hex,
} from "./convert-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

// --- .env 로더 (의존성 없이) ---
function loadEnv(file) {
  try {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* 없으면 무시 */ }
}
loadEnv(join(REPO_ROOT, ".env"));
loadEnv(join(REPO_ROOT, ".env.local"));

const args = process.argv.slice(2);
const sdkIdx = args.indexOf("--sdk");
const sdkPath = sdkIdx >= 0 ? args[sdkIdx + 1] : "/tmp/dk/node_modules";
const inputPath = args.find((a) => !a.startsWith("--") && a !== sdkPath);
if (!inputPath) {
  console.error("사용법: node verify-storage.mjs <file> [--sdk <node_modules>]");
  process.exit(1);
}
// AWS SDK 를 지정 경로에서 로드하는 require.
const sdkRequire = createRequire(join(resolve(sdkPath), "noop.js"));

const KEY_PREFIX = "conversion-dev";
const SOURCE = "bizinfo";
const SOURCE_ID = "PBLN_VERIFY_T4";

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

async function main() {
  const body = readFileSync(inputPath);
  const filename = basename(inputPath);
  const storage = makeStorage();

  console.log(`[T4] 입력: ${filename} (${body.length} bytes)`);

  // --- 1) 변환 + 업로드 ---
  const result = convertDocument({ body, filename, pageImageDpi: 220 });
  console.log(`  변환 jobStatus=${result.jobStatus} format=${result.format} pages=${result.pdf?.pageCount ?? 0} images=${result.pageImages.length} md=${result.markdown ? result.markdown.charCount + "자" : "none"}`);
  if (!result.pdf) {
    console.error(`  변환 실패(error=${result.error}) — R2 업로드할 artifact 없음. H2Orestart 미설치면 HWP/HWPX 는 렌더 불가.`);
    process.exit(3);
  }

  // 캐시 시뮬레이션: 큐를 써서 동일 sha256 재등록 스킵을 증명한다.
  const queue = new ConversionQueue({
    storage, concurrency: 1, keyPrefix: KEY_PREFIX,
    fetchSource: async () => body, // 로컬 버퍼로 다운로드 대체
  });

  console.log(`\n  [1차] job 등록 → 실제 변환+업로드`);
  const rec1 = queue.enqueue({
    jobId: "t4-job-1", source: SOURCE, sourceId: SOURCE_ID, filename,
    sourceObjectUrl: "local://" + filename, sha256: result.sha256,
    requestedArtifacts: ["pdf", "page_images", "markdown"], options: { pageImageDpi: 220 },
  });
  console.log(`    enqueue cached=${rec1.cached} status=${rec1.status}`);
  await queue.drain();
  const done1 = queue.get("t4-job-1");
  console.log(`    완료 status=${done1.status} artifacts=${done1.artifacts.length}`);
  console.log(`    반환 키/URL 목록:`);
  for (const a of done1.artifacts) {
    console.log(`      - [${a.kind}${a.page !== null ? " p" + a.page : ""}] ${a.storageKey}`);
    console.log(`        ${a.url}`);
  }

  // 키 프리픽스 = 원본 sha256 앞 16자 확인
  const pdfArt = done1.artifacts.find((a) => a.kind === "pdf");
  const expectedKey = buildStorageKey({ source: SOURCE, sourceId: SOURCE_ID, filename, sourceSha256: result.sha256, kind: "pdf", keyPrefix: KEY_PREFIX });
  const sha16 = result.sha256.slice(0, 16);
  console.log(`\n    키 검증: 프리픽스에 원본 sha256[0:16]=${sha16} 포함? ${pdfArt.storageKey.includes(sha16) ? "OK" : "FAIL"}`);
  console.log(`    key 규칙 일치? ${pdfArt.storageKey === expectedKey ? "OK" : "FAIL (" + expectedKey + ")"}`);

  // --- 업로드 확인: 인증된 GetObject 로 오브젝트 존재/무결성 대조 ---
  // (R2_BUCKET_URL 은 S3 API 엔드포인트라 미인증 public GET 은 400. 저장소 코드도
  //  getObjectText 로 검증한다 — verify-grant-attachment-archive.ts 참조.)
  console.log(`\n    인증 GetObject 로 업로드 확인 (markdown 은 본문 sha256 대조):`);
  const mdArt = done1.artifacts.find((a) => a.kind === "markdown");
  if (mdArt) {
    const text = await storage.getObjectText(mdArt.storageKey);
    const buf = Buffer.from(text, "utf8");
    const ok = sha256Hex(buf) === mdArt.sha256;
    console.log(`      [markdown] bytes=${buf.length} sha256일치=${ok} => ${ok ? "OK" : "FAIL"}`);
    if (!ok) process.exitCode = 5;
  }
  // pdf/png 는 텍스트가 아니라 존재만 확인 (getObjectText 로 바이트 길이>0).
  for (const a of done1.artifacts.filter((x) => x.kind !== "markdown")) {
    const raw = await storage.getObjectText(a.storageKey);
    const present = Buffer.byteLength(raw, "binary") > 0;
    console.log(`      [${a.kind}${a.page !== null ? " p" + a.page : ""}] R2 오브젝트 존재=${present ? "OK" : "FAIL"}`);
  }

  // --- 2) 동일 sha256 재등록 → 캐시 히트 (스킵) ---
  console.log(`\n  [2차] 동일 sha256 재등록 → 캐시 스킵 기대`);
  const rec2 = queue.enqueue({
    jobId: "t4-job-2", source: SOURCE, sourceId: SOURCE_ID, filename,
    sourceObjectUrl: "local://" + filename, sha256: result.sha256,
  });
  console.log(`    enqueue cached=${rec2.cached} status=${rec2.status} (cached=true 여야 함)`);
  console.log(`    cacheKey=${cacheKey(result.sha256, CONVERTER_VERSION)}`);
  console.log(`    캐시 artifacts 재사용 개수=${rec2.artifacts.length}`);

  console.log(`\n[T4] 결과: 업로드=${done1.artifacts.length}건, 캐시스킵=${rec2.cached ? "동작" : "실패"}`);
  if (!rec2.cached) process.exit(4);
}

main().catch((e) => { console.error(e); process.exit(1); });
