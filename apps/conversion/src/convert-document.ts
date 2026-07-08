// T2: core 변환 모듈 오케스트레이터.
// convertDocument(input) -> { pdf, pageImages[], markdown, quality }
// 계획 5장 파이프라인. 각 단계 실패해도 이전 결과 보존 (부분 성공).

import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkIntegrity } from "./integrity.js";
import { computeQuality } from "./quality.js";
import {
  extractText,
  renderPageImages,
  renderPdf,
  type TextExtractResult,
} from "./render.js";
import {
  CONVERTER_VERSION,
  type ConvertDocumentInput,
  type ConvertDocumentResult,
  type HwpxArtifact,
  type HwpxConversionResult,
  type MarkdownArtifact,
  type PdfArtifact,
} from "./types.js";

/** 원본 파일명을 안전한 로컬 파일명으로. (core hwp-markdown 의 규칙과 정합) */
function sanitizeFilename(filename: string): string {
  const name = basename(filename).replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_");
  return name || "attachment";
}

/**
 * HWP/HWPX → markdown 변환 함수 주입 인터페이스.
 * 프로덕션은 @cunote/core 의 convertHwpBufferToMarkdown 을 주입한다.
 * 미주입 시 PDF 텍스트 fallback 으로 동작 (샌드박스에서 hwp5html 없이 검증 가능).
 */
export type HwpToMarkdownFn = (args: { filename: string; body: Buffer }) => {
  markdown: string;
  converter: string;
};

/**
 * hwp 바이너리 → hwpx 변환 함수 주입 인터페이스 (hwp2hwpx 트랙 Phase 1).
 * 프로덕션은 hwpx-convert.ts 의 hwpxConvert(env jar 사용)를 주입한다.
 * 미주입 시 hwpx 변환 스텝을 건너뛴다(기존 동작 불변).
 */
export type HwpxConvertFn = (args: {
  body: Buffer;
  workDir: string;
}) => HwpxConversionResult;

/**
 * 문서 1건 변환. 결정론적 artifact (pdf / page images / markdown / quality) 생성.
 * LLM 호출 없음.
 */
export function convertDocument(
  input: ConvertDocumentInput,
  deps: { hwpToMarkdown?: HwpToMarkdownFn; hwpxConvert?: HwpxConvertFn } = {},
): ConvertDocumentResult {
  const pageImageDpi = input.pageImageDpi ?? 220;
  const workDir =
    input.workDir ?? mkdtempSync(join(tmpdir(), "cunote-convert."));
  mkdirSync(workDir, { recursive: true });

  const warnings: string[] = [];

  // --- 1단계: 무결성 확인 ---
  const integrity = checkIntegrity({
    body: input.body,
    filename: input.filename,
    expectedSha256: input.expectedSha256,
    maxBytes: input.maxBytes,
  });
  warnings.push(...integrity.warnings);

  if (integrity.fatalReason !== null || integrity.format === null) {
    const quality = computeQuality({
      pdfRendered: false,
      pageImagesRendered: false,
      textExtracted: false,
      renderEngine: null,
      pageCount: 0,
      pageImageDpi,
      extractedCharCount: 0,
      warnings,
    });
    return {
      sha256: integrity.sha256,
      format: integrity.format,
      converterVersion: CONVERTER_VERSION,
      pdf: null,
      pageImages: [],
      markdown: null,
      hwpx: null,
      hwpxConversion: null,
      quality,
      jobStatus: "failed",
      error: integrity.fatalReason ?? "unsupported_format",
    };
  }

  const format = integrity.format;

  // 원본을 작업 디렉토리에 기록 (soffice 입력)
  const safeName = sanitizeFilename(input.filename);
  const sourcePath = join(workDir, safeName);
  writeFileSync(sourcePath, input.body);

  const pdfOutDir = join(workDir, "pdf");
  mkdirSync(pdfOutDir, { recursive: true });

  // --- 2단계: PDF 렌더링 ---
  const pdfRender = renderPdf({
    sourcePath,
    format,
    outDir: pdfOutDir,
    workDir,
    ...(input.sofficeTimeoutMs !== undefined
      ? { timeoutMs: input.sofficeTimeoutMs }
      : {}),
  });
  warnings.push(...pdfRender.warnings);

  if (pdfRender.pdfPath === null || pdfRender.renderEngine === null) {
    // PDF 실패 = 문서 failed. 이후 단계 중단.
    const quality = computeQuality({
      pdfRendered: false,
      pageImagesRendered: false,
      textExtracted: false,
      renderEngine: null,
      pageCount: 0,
      pageImageDpi,
      extractedCharCount: 0,
      warnings,
    });
    return {
      sha256: integrity.sha256,
      format,
      converterVersion: CONVERTER_VERSION,
      pdf: null,
      pageImages: [],
      markdown: null,
      hwpx: null,
      hwpxConversion: null,
      quality,
      jobStatus: "failed",
      error: pdfRender.error ?? "pdf render failed",
    };
  }

  // --- 3단계: page image 생성 ---
  const pagesOutDir = join(workDir, "pages");
  mkdirSync(pagesOutDir, { recursive: true });
  const pageResult = renderPageImages({
    pdfPath: pdfRender.pdfPath,
    outDir: pagesOutDir,
    dpi: pageImageDpi,
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
  });
  warnings.push(...pageResult.warnings);
  const pageImagesRendered = pageResult.pages.length > 0;

  // --- 4단계: 텍스트/markdown 추출 ---
  const textResult: TextExtractResult = extractText({
    format,
    sourcePath,
    sourceBody: input.body,
    filename: input.filename,
    pdfPath: pdfRender.pdfPath,
    workDir,
    ...(deps.hwpToMarkdown ? { hwpToMarkdown: deps.hwpToMarkdown } : {}),
  });
  warnings.push(...textResult.warnings);

  // markdown artifact 파일화
  let markdown: MarkdownArtifact | null = null;
  if (textResult.extracted && textResult.text.length > 0) {
    const mdPath = join(workDir, "markdown.md");
    writeFileSync(mdPath, textResult.text, "utf8");
    markdown = {
      path: mdPath,
      text: textResult.text,
      charCount: textResult.charCount,
      converter: textResult.converter,
    };
  }

  // --- 4.5단계: hwp→hwpx 변환 (요청 시, hwp 바이너리만) ---
  // 요청 artifact 에 "hwpx" 가 포함되고 변환 함수가 주입됐을 때만 시도.
  // 매직 바이트(hwp 바이너리 여부) 판별은 변환 함수 내부에서 수행하고 스킵 사유를 기록한다.
  // 비치명: 실패해도 pdf/page_image/markdown 결과를 훼손하지 않는다.
  let hwpx: HwpxArtifact | null = null;
  let hwpxConversion: HwpxConversionResult | null = null;
  if (input.requestedArtifacts?.includes("hwpx") && deps.hwpxConvert) {
    hwpxConversion = deps.hwpxConvert({ body: input.body, workDir });
    hwpx = hwpxConversion.artifact;
    // 실패·미해당은 정직 보고. skip(정상 미해당)은 warning 으로 승격하지 않는다.
    if (
      hwpxConversion.outcome !== "converted" &&
      hwpxConversion.outcome !== "skipped_already_hwpx" &&
      hwpxConversion.outcome !== "skipped_not_hwp_binary"
    ) {
      warnings.push(`hwpx_conversion_${hwpxConversion.outcome}`);
    }
  }

  const pageCount =
    pageResult.pageCount > 0 ? pageResult.pageCount : pdfRender.renderEngine ? 1 : 0;

  // --- 5단계: quality score 산출 ---
  const quality = computeQuality({
    pdfRendered: true,
    pageImagesRendered,
    textExtracted: markdown !== null,
    renderEngine: pdfRender.renderEngine,
    pageCount,
    pageImageDpi,
    extractedCharCount: markdown?.charCount ?? 0,
    warnings: dedupe(warnings),
  });

  const pdf: PdfArtifact = {
    path: pdfRender.pdfPath,
    pageCount,
    bytes: fileBytes(pdfRender.pdfPath),
    renderEngine: pdfRender.renderEngine,
  };

  // job 상태: PDF 성공 + (page image 또는 markdown 실패) = partial
  const anyDownstreamFailed = !pageImagesRendered || markdown === null;
  const jobStatus: ConvertDocumentResult["jobStatus"] = anyDownstreamFailed
    ? "partial"
    : "succeeded";

  return {
    sha256: integrity.sha256,
    format,
    converterVersion: CONVERTER_VERSION,
    pdf,
    pageImages: pageResult.pages,
    markdown,
    hwpx,
    hwpxConversion,
    quality,
    jobStatus,
    error: null,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
