// 의존성 없는(plain node) 변환 라이브러리 — 샌드박스 검증용.
// src/*.ts 의 로직을 1:1 미러링한다. TS 소스가 정본이며, 이 파일은 pnpm/build
// 없이 node 로 파이프라인을 실행·검증하기 위한 병렬 구현이다.
// 계획: docs/phase2-conversion-server-implementation-plan.md (5장, 6장)

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";

export const CONVERTER_VERSION = "conv-2026.07-lo26.2-h2o0.7.13";
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_SOFFICE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PAGES = 100;
export const EXPECTED_CHARS_PER_PAGE = 800;
export const TEXT_COVERAGE_THRESHOLD = 0.7;
export const SEVERE_WARNINGS = new Set(["font_substitution", "page_image_partial"]);

// ---------- integrity ----------
export function detectFormat(filename) {
  const ext = extname(filename).toLowerCase();
  return { ".hwp": "hwp", ".hwpx": "hwpx", ".pdf": "pdf", ".docx": "docx" }[ext] ?? null;
}
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
export function isHwpEncrypted(buffer) {
  const cfbMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(cfbMagic)) return false;
  const sig = Buffer.from("HWP Document File", "ascii");
  const idx = buffer.indexOf(sig);
  if (idx < 0) return false;
  const propOffset = idx + 32 + 4;
  if (propOffset + 4 > buffer.length) return false;
  return (buffer.readUInt32LE(propOffset) & 0x02) !== 0;
}
export function isHwpxEncrypted(buffer) {
  if (buffer.length < 8) return false;
  if (buffer.readUInt32LE(0) !== 0x04034b50) return false;
  return (buffer.readUInt16LE(6) & 0x0001) !== 0;
}
export function isPdfEncrypted(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") return false;
  return buffer.includes(Buffer.from("/Encrypt", "ascii"));
}
export function checkIntegrity({ body, filename, expectedSha256, maxBytes }) {
  const warnings = [];
  const sha256 = sha256Hex(body);
  const format = detectFormat(filename);
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;
  let fatalReason = null;
  const sha256Mismatch =
    expectedSha256 != null &&
    expectedSha256.length > 0 &&
    expectedSha256.toLowerCase() !== sha256.toLowerCase();
  if (sha256Mismatch) {
    warnings.push("sha256_mismatch");
    fatalReason ??= "sha256_mismatch";
  }
  const oversize = body.length > limit;
  if (oversize) {
    warnings.push("oversize_source");
    fatalReason ??= "oversize_source";
  }
  let encrypted = false;
  if (format === "hwp") encrypted = isHwpEncrypted(body);
  else if (format === "hwpx") encrypted = isHwpxEncrypted(body);
  else if (format === "pdf") encrypted = isPdfEncrypted(body);
  if (encrypted) {
    warnings.push("encrypted_source");
    fatalReason ??= "encrypted_source";
  }
  if (format === null) {
    warnings.push("unsupported_format");
    fatalReason ??= "unsupported_format";
  }
  return { sha256, format, encrypted, oversize, sha256Mismatch, fatalReason, warnings };
}

// ---------- quality ----------
export function estimateTextCoverage({ textExtracted, extractedCharCount, pageCount, expectedCharsPerPage }) {
  if (!textExtracted) return 0;
  const perPage = expectedCharsPerPage ?? EXPECTED_CHARS_PER_PAGE;
  const denom = pageCount * perPage;
  if (denom <= 0) return 0;
  return Math.min(1, Math.max(0, extractedCharCount / denom));
}
export function decideStatus({ pdfRendered, pageImagesRendered, textExtracted, textCoverage, warnings }) {
  if (!pdfRendered) return "failed";
  if (!textExtracted) return "manual_required";
  const hasSevere = warnings.some((w) => SEVERE_WARNINGS.has(w));
  if (textCoverage < TEXT_COVERAGE_THRESHOLD || hasSevere) return "usable_with_review";
  if (pdfRendered && pageImagesRendered) return "usable";
  return "usable_with_review";
}
export function computeQuality(input) {
  const textCoverage = estimateTextCoverage({
    textExtracted: input.textExtracted,
    extractedCharCount: input.extractedCharCount,
    pageCount: input.pageCount,
    expectedCharsPerPage: input.expectedCharsPerPage,
  });
  const status = decideStatus({
    pdfRendered: input.pdfRendered,
    pageImagesRendered: input.pageImagesRendered,
    textExtracted: input.textExtracted,
    textCoverage,
    warnings: input.warnings,
  });
  return {
    pdfRendered: input.pdfRendered,
    pageImagesRendered: input.pageImagesRendered,
    textExtracted: input.textExtracted,
    renderEngine: input.renderEngine,
    pageCount: input.pageCount,
    pageImageDpi: input.pageImageDpi,
    textCoverage,
    extractedCharCount: input.extractedCharCount,
    warnings: input.warnings,
    status,
    visualTextAgreement: null,
    requiredFieldCoverage: null,
    fieldCandidateCount: null,
  };
}

// ---------- render helpers ----------
const sofficeBin = () => process.env.SOFFICE_BIN || "soffice";
const pdftoppmBin = () => process.env.PDFTOPPM_BIN || "pdftoppm";
const pdftotextBin = () => process.env.PDFTOTEXT_BIN || "pdftotext";
const pdfinfoBin = () => process.env.PDFINFO_BIN || "pdfinfo";

function userInstallationArgs(workDir) {
  if (process.env.CONVERSION_LO_SHARED_H2O === "1") {
    return [`-env:UserInstallation=file://${join(workDir, "lo-profile")}`];
  }
  return [];
}
function stem(p) {
  const b = basename(p);
  const ext = extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}
export function countChars(text) {
  return text.replace(/\s+/g, "").length;
}
export function pngDimensions(pngPath) {
  const buf = readFileSync(pngPath);
  if (buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}
export function pdfPageCount(pdfPath) {
  const info = spawnSync(pdfinfoBin(), [pdfPath], { encoding: "utf8" });
  if (info.status === 0 && info.stdout) {
    const m = info.stdout.match(/^Pages:\s+(\d+)/m);
    if (m) return Number(m[1]);
  }
  return 0;
}

export function renderPdf({ sourcePath, format, outDir, workDir, timeoutMs }) {
  const warnings = [];
  if (format === "pdf") {
    const dest = join(outDir, `${stem(sourcePath)}.pdf`);
    try {
      writeFileSync(dest, readFileSync(sourcePath));
    } catch (err) {
      return { pdfPath: null, renderEngine: null, error: `pdf passthrough copy failed: ${err?.message ?? err}`, warnings };
    }
    return { pdfPath: dest, renderEngine: "pdf-passthrough", error: null, warnings };
  }
  const args = [
    ...userInstallationArgs(workDir),
    "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, sourcePath,
  ];
  const result = spawnSync(sofficeBin(), args, {
    encoding: "utf8",
    timeout: timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const killed = result.signal === "SIGTERM";
    return {
      pdfPath: null, renderEngine: null,
      error: killed ? `soffice timeout (>${timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS}ms)` : `soffice spawn error: ${result.error?.message ?? result.error}`,
      warnings,
    };
  }
  const pdf = join(outDir, `${stem(sourcePath)}.pdf`);
  if (!existsSync(pdf)) {
    return { pdfPath: null, renderEngine: null, error: `soffice produced no PDF\nstdout: ${result.stdout}\nstderr: ${result.stderr}`, warnings };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/substitut|font.*not.*found|missing font/i.test(combined)) warnings.push("font_substitution");
  return { pdfPath: pdf, renderEngine: "libreoffice-h2orestart", error: null, warnings };
}

export function renderPageImages({ pdfPath, outDir, dpi, maxPages, timeoutMs }) {
  const warnings = [];
  const limit = maxPages ?? DEFAULT_MAX_PAGES;
  const totalPages = pdfPageCount(pdfPath);
  let partial = false;
  let lastPage;
  if (totalPages > limit) {
    partial = true;
    warnings.push("page_image_partial");
    lastPage = limit;
  }
  const prefix = join(outDir, "page");
  const args = ["-png", "-r", String(dpi), "-f", "1"];
  if (lastPage !== undefined) args.push("-l", String(lastPage));
  args.push(pdfPath, prefix);
  const result = spawnSync(pdftoppmBin(), args, {
    encoding: "utf8",
    timeout: timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { pages: [], pageCount: totalPages, partial: true, error: `pdftoppm error: ${result.error?.message ?? result.error}`, warnings: [...warnings, "page_image_partial"] };
  }
  const produced = readdirSync(outDir).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
  if (produced.length === 0) {
    return { pages: [], pageCount: totalPages, partial: true, error: `pdftoppm produced no images\nstderr: ${result.stderr}`, warnings: [...warnings, "page_image_partial"] };
  }
  const pages = produced.map((f, i) => {
    const p = join(outDir, f);
    const { width, height } = pngDimensions(p);
    const m = f.match(/page-0*(\d+)\.png$/);
    return { page: m ? Number(m[1]) : i + 1, path: p, width, height, dpi, bytes: statSync(p).size };
  });
  return { pages, pageCount: totalPages > 0 ? totalPages : pages.length, partial, error: null, warnings };
}

function pdftotextLayout(pdfPath, workDir) {
  const out = join(workDir, "extract-pdftotext.txt");
  const result = spawnSync(pdftotextBin(), ["-layout", pdfPath, out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || !existsSync(out)) {
    return { text: "", charCount: 0, converter: "pdftotext-layout", extracted: false, error: `pdftotext failed\nstderr: ${result.stderr}`, warnings: [] };
  }
  const text = readFileSync(out, "utf8");
  return { text, charCount: countChars(text), converter: "pdftotext-layout", extracted: text.trim().length > 0, error: null, warnings: [] };
}
function sofficeToTxt(sourcePath, workDir) {
  const result = spawnSync(sofficeBin(), [
    ...userInstallationArgs(workDir), "--headless", "--norestore", "--convert-to", "txt:Text", "--outdir", workDir, sourcePath,
  ], { encoding: "utf8", timeout: DEFAULT_SOFFICE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  const txt = join(workDir, `${stem(sourcePath)}.txt`);
  if (result.error || !existsSync(txt)) {
    return { text: "", charCount: 0, converter: "soffice-txt", extracted: false, error: `soffice txt failed`, warnings: [] };
  }
  const text = readFileSync(txt, "utf8");
  return { text, charCount: countChars(text), converter: "soffice-txt", extracted: text.trim().length > 0, error: null, warnings: [] };
}

// hwpx: zip 안의 section*.xml 을 직접 풀어 텍스트화 (core hwpx-xml-unzip-v1 미러)
function hwpxUnzipText(sourcePath) {
  const r = spawnSync("unzip", ["-p", sourcePath, "Contents/section*.xml"], { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const text = decodeXmlEntities(r.stdout)
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown: text, converter: "hwpx-xml-unzip-v1" };
}
function decodeXmlEntities(v) {
  return v
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));
}

export function extractText({ format, sourcePath, pdfPath, workDir, hwpToMarkdown }) {
  const warnings = [];
  const pdfFallback = () => {
    if (!pdfPath) {
      warnings.push("text_extraction_failed");
      return { text: "", charCount: 0, converter: "none", extracted: false, error: "no PDF fallback", warnings };
    }
    const r = pdftotextLayout(pdfPath, workDir);
    if (!r.extracted) warnings.push("text_extraction_failed");
    return { ...r, warnings: [...warnings, ...r.warnings] };
  };
  if (format === "pdf") {
    const r = pdftotextLayout(pdfPath, workDir);
    if (!r.extracted) warnings.push("text_extraction_failed");
    return { ...r, warnings: [...warnings, ...r.warnings] };
  }
  if (format === "hwp" || format === "hwpx") {
    // 1) 주입된 hwpToMarkdown (core) 시도
    if (hwpToMarkdown) {
      try {
        const res = hwpToMarkdown({ filename: basename(sourcePath), body: readFileSync(sourcePath) });
        if (res && res.markdown && res.markdown.trim().length > 0) {
          return { text: res.markdown, charCount: countChars(res.markdown), converter: res.converter, extracted: true, error: null, warnings };
        }
      } catch { /* fallthrough */ }
    }
    // 2) hwpx 는 zip/XML 직접 추출 (hwp5html 불필요)
    if (format === "hwpx") {
      const res = hwpxUnzipText(sourcePath);
      if (res && res.markdown.trim().length > 0) {
        return { text: res.markdown, charCount: countChars(res.markdown), converter: res.converter, extracted: true, error: null, warnings };
      }
    }
    // 3) PDF 텍스트 fallback
    return pdfFallback();
  }
  if (format === "docx") {
    const r = sofficeToTxt(sourcePath, workDir);
    if (r.extracted && r.text.trim().length > 0) return { ...r, warnings };
    return pdfFallback();
  }
  return pdfFallback();
}

function sanitizeFilename(filename) {
  const name = basename(filename).replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_");
  return name || "attachment";
}
const dedupe = (a) => [...new Set(a)];

// ---------- orchestrator ----------
export function convertDocument(input, deps = {}) {
  const pageImageDpi = input.pageImageDpi ?? 220;
  const workDir = input.workDir ?? mkdtempSync(join(tmpdir(), "cunote-convert."));
  mkdirSync(workDir, { recursive: true });
  const warnings = [];

  const integrity = checkIntegrity({
    body: input.body, filename: input.filename,
    expectedSha256: input.expectedSha256, maxBytes: input.maxBytes,
  });
  warnings.push(...integrity.warnings);

  if (integrity.fatalReason !== null || integrity.format === null) {
    const quality = computeQuality({
      pdfRendered: false, pageImagesRendered: false, textExtracted: false,
      renderEngine: null, pageCount: 0, pageImageDpi, extractedCharCount: 0, warnings: dedupe(warnings),
    });
    return { sha256: integrity.sha256, format: integrity.format, converterVersion: CONVERTER_VERSION,
      pdf: null, pageImages: [], markdown: null, quality, jobStatus: "failed", error: integrity.fatalReason ?? "unsupported_format" };
  }

  const format = integrity.format;
  const sourcePath = join(workDir, sanitizeFilename(input.filename));
  writeFileSync(sourcePath, input.body);
  const pdfOutDir = join(workDir, "pdf");
  mkdirSync(pdfOutDir, { recursive: true });

  const pdfRender = renderPdf({ sourcePath, format, outDir: pdfOutDir, workDir, timeoutMs: input.sofficeTimeoutMs });
  warnings.push(...pdfRender.warnings);

  if (!pdfRender.pdfPath || !pdfRender.renderEngine) {
    const quality = computeQuality({
      pdfRendered: false, pageImagesRendered: false, textExtracted: false,
      renderEngine: null, pageCount: 0, pageImageDpi, extractedCharCount: 0, warnings: dedupe(warnings),
    });
    return { sha256: integrity.sha256, format, converterVersion: CONVERTER_VERSION,
      pdf: null, pageImages: [], markdown: null, quality, jobStatus: "failed", error: pdfRender.error ?? "pdf render failed" };
  }

  const pagesOutDir = join(workDir, "pages");
  mkdirSync(pagesOutDir, { recursive: true });
  const pageResult = renderPageImages({ pdfPath: pdfRender.pdfPath, outDir: pagesOutDir, dpi: pageImageDpi, maxPages: input.maxPages });
  warnings.push(...pageResult.warnings);
  const pageImagesRendered = pageResult.pages.length > 0;

  const textResult = extractText({
    format, sourcePath, pdfPath: pdfRender.pdfPath, workDir, hwpToMarkdown: deps.hwpToMarkdown,
  });
  warnings.push(...textResult.warnings);

  let markdown = null;
  if (textResult.extracted && textResult.text.length > 0) {
    const mdPath = join(workDir, "markdown.md");
    writeFileSync(mdPath, textResult.text, "utf8");
    markdown = { path: mdPath, text: textResult.text, charCount: textResult.charCount, converter: textResult.converter };
  }

  const pageCount = pageResult.pageCount > 0 ? pageResult.pageCount : 1;

  const quality = computeQuality({
    pdfRendered: true, pageImagesRendered, textExtracted: markdown !== null,
    renderEngine: pdfRender.renderEngine, pageCount, pageImageDpi,
    extractedCharCount: markdown?.charCount ?? 0, warnings: dedupe(warnings),
  });

  const pdf = { path: pdfRender.pdfPath, pageCount, bytes: statSync(pdfRender.pdfPath).size, renderEngine: pdfRender.renderEngine };
  const jobStatus = !pageImagesRendered || markdown === null ? "partial" : "succeeded";

  return { sha256: integrity.sha256, format, converterVersion: CONVERTER_VERSION,
    pdf, pageImages: pageResult.pages, markdown, quality, jobStatus, error: null };
}
