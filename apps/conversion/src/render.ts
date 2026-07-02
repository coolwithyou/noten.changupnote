// T2 · 2~4단계: soffice PDF 렌더 · pdftoppm 페이지 이미지 · 텍스트 추출.
// 스파이크 승격: scripts/spike/hwp-render-spike.mjs 의 convertWithLo / thumbnails.
// 계획 5장 2~4단계.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { DocumentFormat, PageImageArtifact, RenderEngine } from "./types.js";

export const DEFAULT_SOFFICE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PAGES = 100;

function sofficeBin(): string {
  return process.env.SOFFICE_BIN || "soffice";
}

/**
 * 문서 1건당 격리된 soffice 프로필을 쓸지 결정.
 * - 프로덕션/Docker: H2Orestart 를 --shared 로 설치했으므로 워커별 임시 UserInstallation 격리 가능.
 *   CONVERSION_LO_SHARED_H2O=1 로 활성화.
 * - 샌드박스/로컬: H2O 가 기본 사용자 프로필에만 있으면 UserInstallation 격리 시 확장이 안 잡힌다.
 *   이 경우 override 를 끄고 기본 HOME 프로필을 쓴다 (기본값).
 */
function userInstallationArgs(workDir: string): string[] {
  if (process.env.CONVERSION_LO_SHARED_H2O === "1") {
    const profileDir = join(workDir, "lo-profile");
    return [`-env:UserInstallation=file://${profileDir}`];
  }
  return [];
}

export interface PdfRenderResult {
  pdfPath: string | null;
  renderEngine: RenderEngine | null;
  error: string | null;
  warnings: string[];
}

/**
 * 2단계: PDF 렌더링.
 * - hwp/hwpx/docx: soffice --headless --convert-to pdf (H2Orestart 필터 자동 선택)
 * - pdf: 원본을 그대로 PDF artifact 로 채택 (재렌더 안 함, pdf-passthrough)
 */
export function renderPdf(input: {
  sourcePath: string;
  format: DocumentFormat;
  outDir: string;
  workDir: string;
  timeoutMs?: number;
}): PdfRenderResult {
  const warnings: string[] = [];

  if (input.format === "pdf") {
    // passthrough: 원본을 outDir 로 복사(쓰기)해 pdf artifact 로 채택
    const dest = join(input.outDir, `${stem(input.sourcePath)}.pdf`);
    try {
      writeFileSync(dest, readFileSync(input.sourcePath));
    } catch (err) {
      return {
        pdfPath: null,
        renderEngine: null,
        error: `pdf passthrough copy failed: ${errMsg(err)}`,
        warnings,
      };
    }
    return { pdfPath: dest, renderEngine: "pdf-passthrough", error: null, warnings };
  }

  const args = [
    ...userInstallationArgs(input.workDir),
    "--headless",
    "--norestore",
    "--convert-to",
    "pdf",
    "--outdir",
    input.outDir,
    input.sourcePath,
  ];

  const result = spawnSync(sofficeBin(), args, {
    encoding: "utf8",
    timeout: input.timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 타임아웃 / kill 감지
  if (result.error) {
    const killed = (result as { signal?: string }).signal === "SIGTERM";
    return {
      pdfPath: null,
      renderEngine: null,
      error: killed
        ? `soffice timeout (>${input.timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS}ms)`
        : `soffice spawn error: ${errMsg(result.error)}`,
      warnings,
    };
  }

  const pdf = join(input.outDir, `${stem(input.sourcePath)}.pdf`);
  if (!existsSync(pdf)) {
    return {
      pdfPath: null,
      renderEngine: null,
      error: `soffice produced no PDF\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      warnings,
    };
  }

  // font substitution 경고 감지 (렌더 깨짐 신호)
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/substitut|font.*not.*found|missing font/i.test(combined)) {
    warnings.push("font_substitution");
  }

  return { pdfPath: pdf, renderEngine: "libreoffice-h2orestart", error: null, warnings };
}

/** pdftoppm 은 총 페이지 수 자리수만큼 zero-pad suffix (-01, -002 ...) 를 붙인다. */
export interface PageImageResult {
  pages: PageImageArtifact[];
  pageCount: number;
  partial: boolean;
  error: string | null;
  warnings: string[];
}

function pdftoppmBin(): string {
  return process.env.PDFTOPPM_BIN || "pdftoppm";
}

/** PDF 총 페이지 수. pdfinfo 대신 pdftoppm 산출물 개수로 판정하기 전 빠른 조회. */
export function pdfPageCount(pdfPath: string): number {
  const info = spawnSync(process.env.PDFINFO_BIN || "pdfinfo", [pdfPath], {
    encoding: "utf8",
  });
  if (info.status === 0 && info.stdout) {
    const m = info.stdout.match(/^Pages:\s+(\d+)/m);
    if (m && m[1]) return Number(m[1]);
  }
  return 0;
}

/**
 * 3단계: pdftoppm -png -r <dpi> 로 페이지 이미지 생성.
 * maxPages 초과 시 앞쪽 maxPages 만 생성하고 partial 처리.
 */
export function renderPageImages(input: {
  pdfPath: string;
  outDir: string;
  dpi: 220 | 300;
  maxPages?: number;
  timeoutMs?: number;
}): PageImageResult {
  const warnings: string[] = [];
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const totalPages = pdfPageCount(input.pdfPath);

  let partial = false;
  let lastPage: number | undefined;
  if (totalPages > maxPages) {
    partial = true;
    warnings.push("page_image_partial");
    lastPage = maxPages;
  }

  const prefix = join(input.outDir, "page");
  const args = ["-png", "-r", String(input.dpi), "-f", "1"];
  if (lastPage !== undefined) args.push("-l", String(lastPage));
  args.push(input.pdfPath, prefix);

  const result = spawnSync(pdftoppmBin(), args, {
    encoding: "utf8",
    timeout: input.timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      pages: [],
      pageCount: totalPages,
      partial: true,
      error: `pdftoppm error: ${errMsg(result.error)}`,
      warnings: [...warnings, "page_image_partial"],
    };
  }

  const produced = readdirSync(input.outDir)
    .filter((f) => f.startsWith("page") && f.endsWith(".png"))
    .sort();

  if (produced.length === 0) {
    return {
      pages: [],
      pageCount: totalPages,
      partial: true,
      error: `pdftoppm produced no images\nstderr: ${result.stderr}`,
      warnings: [...warnings, "page_image_partial"],
    };
  }

  const pages: PageImageArtifact[] = produced.map((f, i) => {
    const p = join(input.outDir, f);
    const { width, height } = pngDimensions(p);
    // pdftoppm suffix "page-NN.png" 에서 페이지 번호 추출
    const m = f.match(/page-0*(\d+)\.png$/);
    const pageNum = m && m[1] ? Number(m[1]) : i + 1;
    return {
      page: pageNum,
      path: p,
      width,
      height,
      dpi: input.dpi,
      bytes: statSync(p).size,
    };
  });

  return {
    pages,
    pageCount: totalPages > 0 ? totalPages : pages.length,
    partial,
    error: null,
    warnings,
  };
}

/** PNG IHDR 에서 width/height 읽기 (외부 의존성 없음). */
export function pngDimensions(pngPath: string): { width: number; height: number } {
  const buf = readFileSync(pngPath);
  // PNG signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(12) === 0x49484452 // "IHDR"
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

export interface TextExtractResult {
  text: string;
  charCount: number;
  converter: string;
  extracted: boolean;
  error: string | null;
  warnings: string[];
}

function pdftotextBin(): string {
  return process.env.PDFTOTEXT_BIN || "pdftotext";
}

/**
 * 4단계: 텍스트/markdown 추출.
 * - hwp/hwpx: extractHwpText (pyhwp hwp5html / hwpx-xml-unzip). 실패 시 PDF 텍스트 fallback.
 * - pdf: pdftotext -layout
 * - docx: soffice --convert-to txt (fallback: PDF 텍스트)
 *
 * extractHwpText 는 @cunote/core 의 convertHwpBufferToMarkdown 를 주입받는다
 * (빌드 없이 검증하기 위해 함수 주입 형태로 분리).
 */
export function extractText(input: {
  format: DocumentFormat;
  sourcePath: string;
  sourceBody: Buffer;
  filename: string;
  pdfPath: string | null;
  workDir: string;
  hwpToMarkdown?: (args: { filename: string; body: Buffer }) => {
    markdown: string;
    converter: string;
  };
}): TextExtractResult {
  const warnings: string[] = [];

  const pdfFallback = (): TextExtractResult => {
    if (!input.pdfPath) {
      warnings.push("text_extraction_failed");
      return {
        text: "",
        charCount: 0,
        converter: "none",
        extracted: false,
        error: "no source-native text and no PDF for fallback",
        warnings,
      };
    }
    const r = pdftotextLayout(input.pdfPath, input.workDir);
    if (!r.extracted) warnings.push("text_extraction_failed");
    return { ...r, warnings: [...warnings, ...r.warnings] };
  };

  if (input.format === "pdf") {
    if (!input.pdfPath) {
      warnings.push("text_extraction_failed");
      return {
        text: "",
        charCount: 0,
        converter: "none",
        extracted: false,
        error: "no PDF path",
        warnings,
      };
    }
    const r = pdftotextLayout(input.pdfPath, input.workDir);
    if (!r.extracted) warnings.push("text_extraction_failed");
    return { ...r, warnings: [...warnings, ...r.warnings] };
  }

  if (input.format === "hwp" || input.format === "hwpx") {
    if (input.hwpToMarkdown) {
      try {
        const res = input.hwpToMarkdown({
          filename: input.filename,
          body: input.sourceBody,
        });
        const text = res.markdown ?? "";
        if (text.trim().length > 0) {
          return {
            text,
            charCount: countChars(text),
            converter: res.converter,
            extracted: true,
            error: null,
            warnings,
          };
        }
      } catch {
        // hwp5html 미설치 등 — PDF 텍스트로 fallback
      }
    }
    return pdfFallback();
  }

  // docx: soffice txt 변환 시도, 실패 시 PDF fallback
  if (input.format === "docx") {
    const r = sofficeToTxt(input.sourcePath, input.workDir);
    if (r.extracted && r.text.trim().length > 0) return { ...r, warnings };
    return pdfFallback();
  }

  return pdfFallback();
}

function pdftotextLayout(pdfPath: string, workDir: string): TextExtractResult {
  const out = join(workDir, "extract-pdftotext.txt");
  const result = spawnSync(pdftotextBin(), ["-layout", pdfPath, out], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !existsSync(out)) {
    return {
      text: "",
      charCount: 0,
      converter: "pdftotext-layout",
      extracted: false,
      error: `pdftotext failed\nstderr: ${result.stderr}`,
      warnings: [],
    };
  }
  const text = readFileSync(out, "utf8");
  return {
    text,
    charCount: countChars(text),
    converter: "pdftotext-layout",
    extracted: text.trim().length > 0,
    error: null,
    warnings: [],
  };
}

function sofficeToTxt(sourcePath: string, workDir: string): TextExtractResult {
  const result = spawnSync(
    sofficeBin(),
    [
      ...userInstallationArgs(workDir),
      "--headless",
      "--norestore",
      "--convert-to",
      "txt:Text",
      "--outdir",
      workDir,
      sourcePath,
    ],
    { encoding: "utf8", timeout: DEFAULT_SOFFICE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
  );
  const txt = join(workDir, `${stem(sourcePath)}.txt`);
  if (result.error || !existsSync(txt)) {
    return {
      text: "",
      charCount: 0,
      converter: "soffice-txt",
      extracted: false,
      error: `soffice txt failed: ${result.error ? errMsg(result.error) : result.stderr}`,
      warnings: [],
    };
  }
  const text = readFileSync(txt, "utf8");
  return {
    text,
    charCount: countChars(text),
    converter: "soffice-txt",
    extracted: text.trim().length > 0,
    error: null,
    warnings: [],
  };
}

/** 공백 제외 실질 글자수. textCoverage 추정의 분자. */
export function countChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function stem(p: string): string {
  const b = basename(p);
  const ext = extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
