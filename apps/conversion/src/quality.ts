// T3: quality score 산출 (계획 6장) — 순수 함수.
// docs/phase2-conversion-server-implementation-plan.md 6장

import type {
  ConversionQualityStatus,
  Phase2ConversionQuality,
  RenderEngine,
} from "./types.js";

/**
 * 페이지당 기대 글자수 (양식류 밀도). Gate 2 분포로 보정 예정.
 * 계획 6장: EXPECTED_CHARS_PER_PAGE 기본 800.
 */
export const EXPECTED_CHARS_PER_PAGE = 800;

/** textCoverage 임계값 (계획 6장, 마스터 13장 잠정치). Gate 2에서 캘리브레이션. */
export const TEXT_COVERAGE_THRESHOLD = 0.7;

/**
 * 심각(severe) warning 목록. 하나라도 있으면 usable로 승격하지 않는다.
 * 계획 6장: "warnings에 심각 항목" → usable_with_review.
 */
export const SEVERE_WARNINGS = new Set<string>([
  "font_substitution",
  "page_image_partial",
]);

export interface ComputeQualityInput {
  pdfRendered: boolean;
  pageImagesRendered: boolean;
  textExtracted: boolean;
  renderEngine: RenderEngine | null;
  pageCount: number;
  pageImageDpi: 220 | 300;
  extractedCharCount: number;
  warnings: string[];
  /** 페이지당 기대 글자수 (기본 EXPECTED_CHARS_PER_PAGE). */
  expectedCharsPerPage?: number;
}

/**
 * textCoverage 추정. 마크다운 글자수 기반.
 * min(1, extractedCharCount / (pageCount * EXPECTED_CHARS_PER_PAGE)).
 * 텍스트 추출 실패 시 0. pageCount<=0 이면 0 (분모 방지).
 */
export function estimateTextCoverage(input: {
  textExtracted: boolean;
  extractedCharCount: number;
  pageCount: number;
  expectedCharsPerPage?: number;
}): number {
  if (!input.textExtracted) return 0;
  const perPage = input.expectedCharsPerPage ?? EXPECTED_CHARS_PER_PAGE;
  const denom = input.pageCount * perPage;
  if (denom <= 0) return 0;
  const raw = input.extractedCharCount / denom;
  return Math.min(1, Math.max(0, raw));
}

/**
 * status 판정 (계획 6장 Phase 2 잠정 규칙).
 *  - failed: pdfRendered=false
 *  - manual_required: pdfRendered=true, textExtracted=false (이미지만 있음)
 *  - usable_with_review: textCoverage < 0.7 또는 warnings에 심각 항목
 *  - usable: pdfRendered && pageImagesRendered && textCoverage >= 0.7 (심각 warning 없음)
 */
export function decideStatus(input: {
  pdfRendered: boolean;
  pageImagesRendered: boolean;
  textExtracted: boolean;
  textCoverage: number;
  warnings: string[];
}): ConversionQualityStatus {
  if (!input.pdfRendered) return "failed";
  if (!input.textExtracted) return "manual_required";

  const hasSevereWarning = input.warnings.some((w) => SEVERE_WARNINGS.has(w));
  if (input.textCoverage < TEXT_COVERAGE_THRESHOLD || hasSevereWarning) {
    return "usable_with_review";
  }
  if (input.pdfRendered && input.pageImagesRendered) {
    return "usable";
  }
  // pdf는 됐고 텍스트는 있으나 page image가 없는 경계 케이스.
  return "usable_with_review";
}

/**
 * 최종 quality 객체 산출 (순수 함수). 계획 6장.
 * Phase 4 필드(visualTextAgreement 등)는 null 고정.
 */
export function computeQuality(input: ComputeQualityInput): Phase2ConversionQuality {
  const textCoverage = estimateTextCoverage({
    textExtracted: input.textExtracted,
    extractedCharCount: input.extractedCharCount,
    pageCount: input.pageCount,
    ...(input.expectedCharsPerPage !== undefined
      ? { expectedCharsPerPage: input.expectedCharsPerPage }
      : {}),
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
