#!/usr/bin/env node
// T2 검증: 단일 문서 변환 → pdf + page images + markdown + quality JSON 생성.
// 사용법: node apps/conversion/scripts/verify-convert.mjs <파일> <outdir>
//
// 주의: HWP 텍스트 추출은 pyhwp(hwp5html) 가 있으면 사용, 없으면 PDF 텍스트 fallback.
// HWPX 는 zip/XML 직접 추출. soffice + H2Orestart 는 기본 HOME 프로필에 설치돼 있어야 한다.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { convertDocument } from "./convert-lib.mjs";

const [, , inputPath, outDirArg] = process.argv;
if (!inputPath || !outDirArg) {
  console.error("사용법: node verify-convert.mjs <파일> <outdir>");
  process.exit(1);
}
const outDir = outDirArg;
mkdirSync(outDir, { recursive: true });

const body = readFileSync(inputPath);
const filename = basename(inputPath);

const result = convertDocument({ body, filename, pageImageDpi: 220, workDir: join(outDir, "work") });

// artifact 복사 (work 디렉토리 밖으로)
if (result.pdf) {
  copyFileSync(result.pdf.path, join(outDir, "document.pdf"));
}
const pagesDir = join(outDir, "pages");
mkdirSync(pagesDir, { recursive: true });
const pageManifest = [];
for (const img of result.pageImages) {
  const dest = join(pagesDir, `p${String(img.page).padStart(3, "0")}.png`);
  copyFileSync(img.path, dest);
  pageManifest.push({ page: img.page, file: `pages/${basename(dest)}`, width: img.width, height: img.height, dpi: img.dpi, bytes: img.bytes });
}
if (result.markdown) {
  writeFileSync(join(outDir, "markdown.md"), result.markdown.text, "utf8");
}

const summary = {
  input: filename,
  sha256: result.sha256,
  format: result.format,
  converterVersion: result.converterVersion,
  jobStatus: result.jobStatus,
  error: result.error,
  pdf: result.pdf ? { file: "document.pdf", pageCount: result.pdf.pageCount, bytes: result.pdf.bytes, renderEngine: result.pdf.renderEngine } : null,
  pageImages: pageManifest,
  markdown: result.markdown ? { file: "markdown.md", charCount: result.markdown.charCount, converter: result.markdown.converter } : null,
  quality: result.quality,
};
writeFileSync(join(outDir, "quality.json"), JSON.stringify(summary, null, 2), "utf8");

console.log(`[${result.jobStatus}] ${filename}`);
console.log(`  format=${result.format} engine=${result.pdf?.renderEngine ?? "-"} pages=${result.pdf?.pageCount ?? 0} images=${pageManifest.length}`);
console.log(`  text: ${result.markdown ? `${result.markdown.charCount} chars via ${result.markdown.converter}` : "FAILED"}`);
console.log(`  quality.status=${result.quality.status} textCoverage=${result.quality.textCoverage.toFixed(3)} warnings=[${result.quality.warnings.join(",")}]`);
console.log(`  → ${outDir}/quality.json`);
