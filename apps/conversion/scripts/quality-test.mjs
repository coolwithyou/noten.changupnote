#!/usr/bin/env node
// T3 검증: computeQuality() 단위 테스트성 assert.
// 정상 / 텍스트실패 / 렌더실패 3케이스 + 경계 케이스.
// 사용법: node apps/conversion/scripts/quality-test.mjs

import assert from "node:assert/strict";
import { computeQuality, decideStatus, estimateTextCoverage } from "./convert-lib.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("computeQuality / decideStatus / estimateTextCoverage 단위 테스트\n");

// --- 케이스 1: 정상 (렌더+이미지+충분한 텍스트) → usable ---
check("정상 케이스 → usable", () => {
  const q = computeQuality({
    pdfRendered: true, pageImagesRendered: true, textExtracted: true,
    renderEngine: "libreoffice-h2orestart", pageCount: 5, pageImageDpi: 220,
    extractedCharCount: 5 * 800, warnings: [],
  });
  assert.equal(q.status, "usable");
  assert.equal(q.textCoverage, 1); // 4000 / (5*800) = 1
  assert.equal(q.visualTextAgreement, null);
  assert.equal(q.requiredFieldCoverage, null);
  assert.equal(q.fieldCandidateCount, null);
});

// --- 케이스 2: 텍스트 추출 실패 (PDF는 됨, 텍스트 없음) → manual_required ---
check("텍스트 추출 실패 → manual_required", () => {
  const q = computeQuality({
    pdfRendered: true, pageImagesRendered: true, textExtracted: false,
    renderEngine: "libreoffice-h2orestart", pageCount: 3, pageImageDpi: 220,
    extractedCharCount: 0, warnings: ["text_extraction_failed"],
  });
  assert.equal(q.status, "manual_required");
  assert.equal(q.textCoverage, 0);
});

// --- 케이스 3: 렌더 실패 (PDF 자체 실패) → failed ---
check("PDF 렌더 실패 → failed", () => {
  const q = computeQuality({
    pdfRendered: false, pageImagesRendered: false, textExtracted: false,
    renderEngine: null, pageCount: 0, pageImageDpi: 220,
    extractedCharCount: 0, warnings: ["encrypted_source"],
  });
  assert.equal(q.status, "failed");
  assert.equal(q.renderEngine, null);
});

// --- 경계: textCoverage < 0.7 → usable_with_review ---
check("낮은 textCoverage(<0.7) → usable_with_review", () => {
  const q = computeQuality({
    pdfRendered: true, pageImagesRendered: true, textExtracted: true,
    renderEngine: "libreoffice-h2orestart", pageCount: 10, pageImageDpi: 220,
    extractedCharCount: 10 * 800 * 0.5, warnings: [], // coverage=0.5
  });
  assert.equal(q.textCoverage, 0.5);
  assert.equal(q.status, "usable_with_review");
});

// --- 경계: 심각 warning(font_substitution) 있으면 usable 승격 금지 ---
check("심각 warning 있으면 usable_with_review", () => {
  const q = computeQuality({
    pdfRendered: true, pageImagesRendered: true, textExtracted: true,
    renderEngine: "libreoffice-h2orestart", pageCount: 2, pageImageDpi: 220,
    extractedCharCount: 2 * 800, warnings: ["font_substitution"], // coverage=1 이지만 심각 warning
  });
  assert.equal(q.textCoverage, 1);
  assert.equal(q.status, "usable_with_review");
});

// --- 경계: page image 없음(pdf+text 는 있음) → usable_with_review ---
check("page image 없음 → usable_with_review", () => {
  const q = computeQuality({
    pdfRendered: true, pageImagesRendered: false, textExtracted: true,
    renderEngine: "libreoffice-h2orestart", pageCount: 2, pageImageDpi: 220,
    extractedCharCount: 2 * 800, warnings: ["page_image_partial"],
  });
  assert.equal(q.status, "usable_with_review");
});

// --- estimateTextCoverage 순수 함수 ---
check("estimateTextCoverage: 분모 0 방어", () => {
  assert.equal(estimateTextCoverage({ textExtracted: true, extractedCharCount: 100, pageCount: 0 }), 0);
});
check("estimateTextCoverage: 미추출 → 0", () => {
  assert.equal(estimateTextCoverage({ textExtracted: false, extractedCharCount: 9999, pageCount: 5 }), 0);
});
check("estimateTextCoverage: 상한 1 클램프", () => {
  assert.equal(estimateTextCoverage({ textExtracted: true, extractedCharCount: 100000, pageCount: 1 }), 1);
});

// --- decideStatus 우선순위: failed > manual_required > review > usable ---
check("decideStatus 우선순위: pdf 실패가 최우선", () => {
  assert.equal(decideStatus({ pdfRendered: false, pageImagesRendered: true, textExtracted: true, textCoverage: 1, warnings: [] }), "failed");
});

console.log(`\n✅ 전체 ${passed}개 통과`);
