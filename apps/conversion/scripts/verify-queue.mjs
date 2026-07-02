#!/usr/bin/env node
// T5 검증: 동시 5건 등록 시 동시성 2 유지 · 전건 완료 (로그로 증명).
// 실행: node apps/conversion/scripts/verify-queue.mjs [file]
//
// R2 없이 stub storage 로 큐 동작만 검증한다 (동시성/완료). 실제 업로드는 T4/T6 에서.
// 각 job 은 실제 convertDocument 를 돈다 (soffice/pdftoppm 있으면 PDF, 없으면 실패해도 큐 완료는 확인).

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ConversionQueue, sha256Hex } from "./convert-lib.mjs";

// stub storage: 업로드를 실제로 안 하고 key/url 만 반환.
const stubStorage = {
  async putObject({ key }) { return { key, url: `stub://${key}` }; },
  async getObjectText() { return ""; },
  publicUrl(key) { return `stub://${key}`; },
};

// 테스트용 PDF N개 생성 (각각 본문이 달라 서로 다른 실제 sha256 → 캐시 회피 + 정상 변환).
function makeTestPdfs(n) {
  const dir = mkdtempSync(join(tmpdir(), "cunote-t5src."));
  const soffice = process.env.SOFFICE_BIN || "soffice";
  const paths = [];
  for (let i = 0; i < n; i += 1) {
    const txt = join(dir, `sample-${i}.txt`);
    writeFileSync(txt, `T5 큐 검증 문서 #${i}\n동시성 테스트용 샘플 (문서 ${i}).\n지원사업 신청서 양식 예시 페이지 ${i}.\n`, "utf8");
    spawnSync(soffice, ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, txt], { encoding: "utf8", timeout: 90000 });
    paths.push(join(dir, `sample-${i}.pdf`));
  }
  return paths;
}

const N = 5;
// 인자로 파일을 주면 그 파일을 N번(본문에 index 접미 바이트를 붙여 sha 분리) 사용.
const inputArg = process.argv[2];
let bodies;
let filename;
if (inputArg) {
  const base = readFileSync(inputArg);
  filename = basename(inputArg);
  bodies = Array.from({ length: N }, (_, i) => Buffer.concat([base, Buffer.from(`\n%T5-${i}`)]));
} else {
  const paths = makeTestPdfs(N);
  bodies = paths.map((p) => readFileSync(p));
  filename = "sample.pdf";
  if (bodies.some((b) => !b || b.length === 0)) {
    console.error("테스트 PDF 생성 실패 (soffice 필요). 인자로 파일 경로를 넘기세요.");
    process.exit(2);
  }
}


async function main() {
  const CONCURRENCY = 2;
  // URL → body 디스패치 (job 별 서로 다른 원본). 150ms 지연으로 동시성 관측.
  const byUrl = new Map(bodies.map((b, i) => [`local://${i}`, b]));
  const fetchSource = async (url) => {
    await new Promise((r) => setTimeout(r, 150));
    return byUrl.get(url);
  };
  const queue = new ConversionQueue({
    storage: stubStorage, concurrency: CONCURRENCY, keyPrefix: "conversion-dev", fetchSource,
  });

  let observedPeak = 0;
  const sampler = setInterval(() => { observedPeak = Math.max(observedPeak, queue.active); }, 5);

  console.log(`[T5] 동시 ${N}건 등록 (concurrency=${CONCURRENCY}, 각 job 은 서로 다른 실제 sha256 → 캐시 회피 + 정상 변환)`);
  for (let i = 0; i < N; i += 1) {
    const realSha = sha256Hex(bodies[i]); // 실제 sha256 → 무결성 통과
    const rec = queue.enqueue({
      jobId: `t5-job-${i}`, source: "bizinfo", sourceId: "PBLN_T5",
      filename, sourceObjectUrl: `local://${i}`, sha256: realSha,
    });
    console.log(`  enqueue ${rec.jobId} status=${rec.status} active=${queue.active} peak=${queue.peakActive}`);
  }

  await queue.drain();
  clearInterval(sampler);

  const records = Array.from({ length: N }, (_, i) => queue.get(`t5-job-${i}`));
  const terminated = records.filter((r) => r && ["succeeded", "partial", "failed"].includes(r.status)).length;
  const okConverted = records.filter((r) => r && ["succeeded", "partial"].includes(r.status)).length;
  const statuses = records.map((r) => `${r.jobId}=${r.status}`).join(", ");

  console.log(`\n[T5] 결과:`);
  console.log(`  전건 종료: ${terminated}/${N} (정상 변환 ${okConverted}/${N})`);
  console.log(`  상태: ${statuses}`);
  console.log(`  큐 내부 peakActive=${queue.peakActive} (샘플러 관측 peak=${observedPeak})`);
  console.log(`  동시성 상한 준수(peak <= ${CONCURRENCY}): ${queue.peakActive <= CONCURRENCY ? "OK" : "FAIL"}`);
  console.log(`  동시성 실제 도달(peak == ${CONCURRENCY}): ${queue.peakActive === CONCURRENCY ? "OK" : "미도달(peak=" + queue.peakActive + ")"}`);

  const pass = terminated === N && queue.peakActive === CONCURRENCY && okConverted === N;
  console.log(`\n[T5] ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
