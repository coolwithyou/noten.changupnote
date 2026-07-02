#!/usr/bin/env node
// T2 검증: 샘플 디렉토리 전체 배치 변환 → 성공률/quality 분포 보고.
// 사용법: node apps/conversion/scripts/batch-convert.mjs <samples_dir> [outdir]

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { convertDocument } from "./convert-lib.mjs";

const [, , samplesDir, outDirArg] = process.argv;
if (!samplesDir) {
  console.error("사용법: node batch-convert.mjs <samples_dir> [outdir]");
  process.exit(1);
}
const outDir = outDirArg ?? mkdtempSync(join(tmpdir(), "cunote-batch."));
mkdirSync(outDir, { recursive: true });

const files = readdirSync(samplesDir).filter((f) => /\.(hwp|hwpx|pdf|docx)$/i.test(f)).sort();
console.log(`샘플 ${files.length}건 · outDir=${outDir}\n`);

const rows = [];
const statusCount = {};
const jobCount = {};
let ok = 0;

for (const f of files) {
  const body = readFileSync(join(samplesDir, f));
  const workDir = join(outDir, "work", f.replace(/[^\w.-]/g, "_"));
  const t0 = Date.now();
  let r;
  try {
    r = convertDocument({ body, filename: f, pageImageDpi: 220, workDir });
  } catch (err) {
    r = { jobStatus: "failed", error: String(err?.message ?? err), format: null, pdf: null, pageImages: [], markdown: null, quality: { status: "failed", textCoverage: 0, warnings: ["exception"] } };
  }
  const ms = Date.now() - t0;
  const rendered = r.pdf != null;
  if (rendered) ok += 1;
  statusCount[r.quality.status] = (statusCount[r.quality.status] ?? 0) + 1;
  jobCount[r.jobStatus] = (jobCount[r.jobStatus] ?? 0) + 1;
  rows.push({
    file: f, format: r.format, jobStatus: r.jobStatus, qualityStatus: r.quality.status,
    pdfRendered: rendered, pageCount: r.pdf?.pageCount ?? 0, images: r.pageImages.length,
    textChars: r.markdown?.charCount ?? 0, textConverter: r.markdown?.converter ?? null,
    textCoverage: r.quality.textCoverage, warnings: r.quality.warnings, ms, error: r.error,
  });
  const tag = rendered ? "OK  " : "FAIL";
  console.log(`${tag} ${(ms / 1000).toFixed(1)}s ${r.jobStatus.padEnd(9)} ${r.quality.status.padEnd(18)} img=${String(r.pageImages.length).padStart(3)} chars=${String(r.markdown?.charCount ?? 0).padStart(6)} ${f}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  samplesDir, total: files.length,
  pdfRenderedOk: ok, pdfRenderRate: files.length ? Math.round((ok / files.length) * 1000) / 10 : 0,
  jobStatusDistribution: jobCount, qualityStatusDistribution: statusCount, rows,
};
writeFileSync(join(outDir, "batch-report.json"), JSON.stringify(report, null, 2), "utf8");

console.log(`\n=== 배치 결과 ===`);
console.log(`PDF 렌더 성공: ${ok}/${files.length} (${report.pdfRenderRate}%)`);
console.log(`jobStatus 분포:`, jobCount);
console.log(`quality.status 분포:`, statusCount);
console.log(`리포트: ${outDir}/batch-report.json`);
