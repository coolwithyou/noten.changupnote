/**
 * field-reconciliation.ts 픽스처 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/documents/field-reconciliation.test.ts
 *
 * 커버: §8.6 규칙 ①~⑥ 각 1케이스 이상 + 병합/충돌 엣지 케이스.
 * 후보는 §8.4 스키마 기반 합성 CandidateSet 이다(실 엔진 출력 아님).
 */
import assert from "node:assert/strict";
import type { BBox, CandidateKind, CandidateSet, NormalizedFieldCandidate } from "./field-candidates.js";
import { reconcileFieldCandidates, RECONCILE_THRESHOLDS, iou, labelSimilarity } from "./field-reconciliation.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function layoutCand(input: {
  label: string;
  page: number;
  bbox: BBox;
  kind?: CandidateKind;
  confidence?: number | null;
}): NormalizedFieldCandidate {
  return {
    page: input.page,
    bbox: input.bbox,
    bboxSource: "layout",
    layer: "layout",
    kind: input.kind ?? "text_input",
    label: input.label,
    text: "",
    confidence: input.confidence ?? null,
    rotationDeg: null,
    raw: {},
  };
}

function textCand(input: {
  label: string;
  fieldKey: string;
  fieldType?: string;
  fillStrategy?: string;
  required?: boolean;
  section?: string | null;
  sourceSpan?: string | null;
  kind?: CandidateKind;
  confidence?: number | null;
  documentName?: string;
  documentCategory?: string;
  mappedCompanyField?: string | null;
}): NormalizedFieldCandidate {
  return {
    page: null,
    bbox: null,
    bboxSource: "text_parser",
    layer: "text_parser",
    kind: input.kind ?? "text_input",
    label: input.label,
    text: "",
    confidence: input.confidence ?? 0.8,
    rotationDeg: null,
    raw: {
      fieldKey: input.fieldKey,
      label: input.label,
      fieldType: input.fieldType ?? "text",
      fillStrategy: input.fillStrategy ?? "ask_user",
      required: input.required ?? false,
      section: input.section ?? null,
      sourceSpan: input.sourceSpan ?? null,
      documentName: input.documentName ?? "신청서",
      documentCategory: input.documentCategory ?? "application_form",
      mappedCompanyField: input.mappedCompanyField ?? null,
    },
  };
}

function layoutSet(candidates: NormalizedFieldCandidate[], engine = "synthetic-layout"): CandidateSet {
  return { engine, engineVersion: "test-1", layer: "layout", extractedAt: "2026-07-05T00:00:00Z", candidates };
}
function textSet(candidates: NormalizedFieldCandidate[], engine = "text-parser"): CandidateSet {
  return { engine, engineVersion: "test-1", layer: "text_parser", extractedAt: "2026-07-05T00:00:00Z", candidates };
}

console.log("field-reconciliation 단위 테스트\n");

// 헬퍼 자립 검증 (metrics 재구현 정합).
check("헬퍼: iou / labelSimilarity", () => {
  assert.ok(Math.abs(iou([0, 0, 1, 1], [0.5, 0, 1, 1]) - 1 / 3) < 1e-9);
  assert.equal(labelSimilarity("사업자등록번호", "사업자등록번호"), 1);
  assert.ok(labelSimilarity("사업자등록번호", "공장등록번호") < 0.7);
});

// --- rule ① text + layout 동일 → high ---
check("rule ①: text+layout 매칭 → high, position 有, 텍스트 fillStrategy 승계", () => {
  const layout = layoutSet([
    layoutCand({ label: "사업자등록번호", page: 1, bbox: [0.28, 0.16, 0.15, 0.04], confidence: 0.9 }),
  ]);
  const text = textSet([
    textCand({
      label: "사업자등록번호",
      fieldKey: "company.biz_no",
      fillStrategy: "copy",
      required: true,
      section: "기본 정보",
      sourceSpan: "사업자등록번호",
      mappedCompanyField: "biz_no",
    }),
  ]);
  const out = reconcileFieldCandidates([layout, text]);
  assert.equal(out.length, 1);
  const f = out[0]!;
  assert.equal(f.tier, "high");
  assert.equal(f.fieldKey, "company.biz_no");
  assert.equal(f.fillStrategy, "copy");
  assert.equal(f.mappedCompanyField, "biz_no");
  assert.ok(f.confidence >= RECONCILE_THRESHOLDS.highConfidence - 1e-9);
  assert.deepEqual(f.position, { page: 1, bbox: [0.28, 0.16, 0.15, 0.04] });
  assert.ok(f.visualEvidence && f.textEvidence);
  assert.equal(f.reviewRequired, false);
});

// --- rule ② layout 만 → medium ---
check("rule ②: layout 만 → medium, position 有, fieldKey=layout.*", () => {
  const layout = layoutSet([
    layoutCand({ label: "빈칸 A", page: 2, bbox: [0.1, 0.3, 0.2, 0.05], confidence: 0.7 }),
  ]);
  const out = reconcileFieldCandidates([layout]);
  assert.equal(out.length, 1);
  const f = out[0]!;
  assert.equal(f.tier, "medium");
  assert.ok(f.fieldKey.startsWith("layout."));
  assert.ok(f.position && f.position.bbox);
  assert.equal(f.textEvidence, null);
  assert.ok(f.confidence <= RECONCILE_THRESHOLDS.mediumConfidence + 1e-9);
});

// --- rule ③ text 만 → medium, position 없음 ---
check("rule ③: text 만 → medium, position null", () => {
  const text = textSet([
    textCand({ label: "추진 계획", fieldKey: "business.execution_plan", fillStrategy: "generate", fieldType: "long_text" }),
  ]);
  const out = reconcileFieldCandidates([text]);
  assert.equal(out.length, 1);
  const f = out[0]!;
  assert.equal(f.tier, "medium");
  assert.equal(f.position, null);
  assert.equal(f.fieldType, "long_text");
  assert.ok(f.textEvidence);
});

// --- rule ④ 서명/직인/동의 → manual 강제 ---
check("rule ④: 서명 kind → fillStrategy manual 강제 (텍스트가 copy 라도)", () => {
  const layout = layoutSet([
    layoutCand({ label: "대표자 서명", page: 1, bbox: [0.2, 0.57, 0.3, 0.03], kind: "signature", confidence: 0.9 }),
  ]);
  const text = textSet([
    textCand({ label: "대표자 서명", fieldKey: "manual.signature", fillStrategy: "copy", kind: "signature" }),
  ]);
  const out = reconcileFieldCandidates([layout, text]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.fillStrategy, "manual");
});

check("rule ④: text-only 동의 라벨 → manual", () => {
  const text = textSet([
    textCand({ label: "개인정보 수집·이용 동의", fieldKey: "manual.consent", fillStrategy: "ask_user" }),
  ]);
  const out = reconcileFieldCandidates([text]);
  assert.equal(out[0]!.fillStrategy, "manual");
});

// --- rule ⑤ layout 중복 IoU 병합 ---
check("rule ⑤: 겹치는 layout 후보 2개 → 1개로 병합 (대표=고신뢰)", () => {
  const layout = layoutSet([
    layoutCand({ label: "성명", page: 1, bbox: [0.2, 0.2, 0.3, 0.05], kind: "text_input", confidence: 0.6 }),
    layoutCand({ label: "성명", page: 1, bbox: [0.21, 0.2, 0.3, 0.05], kind: "text_input", confidence: 0.95 }),
  ]);
  const out = reconcileFieldCandidates([layout]);
  assert.equal(out.length, 1);
  const f = out[0]!;
  assert.equal((f.visualEvidence as { mergedFrom?: number }).mergedFrom, 2);
  // 대표 bbox 는 고신뢰(0.95) 멤버 것.
  assert.deepEqual(f.position!.bbox, [0.21, 0.2, 0.3, 0.05]);
});

// --- rule ⑥ 저신뢰 → reviewRequired ---
check("rule ⑥: 저신뢰 text 후보 → reviewRequired", () => {
  const text = textSet([
    textCand({ label: "예산 산출근거", fieldKey: "business.budget_items", confidence: 0.3, fieldType: "table", fillStrategy: "ask_user" }),
  ]);
  const out = reconcileFieldCandidates([text]);
  assert.equal(out[0]!.reviewRequired, true);
  assert.ok(out[0]!.confidence < RECONCILE_THRESHOLDS.lowConfidence);
});

// --- 엣지 1: text 가 두 겹치지 않는 layout 중 하나만 매칭, 나머지는 layout-only ---
check("엣지: text 1 + layout 2(비겹침) → 매칭 1(high) + layout-only 1(medium)", () => {
  const layout = layoutSet([
    layoutCand({ label: "사업자등록번호", page: 1, bbox: [0.28, 0.16, 0.15, 0.04], confidence: 0.9 }),
    layoutCand({ label: "대표자 성명", page: 1, bbox: [0.28, 0.5, 0.2, 0.04], confidence: 0.8 }),
  ]);
  const text = textSet([
    textCand({ label: "사업자등록번호", fieldKey: "company.biz_no", fillStrategy: "copy" }),
  ]);
  const out = reconcileFieldCandidates([layout, text]);
  assert.equal(out.length, 2);
  const high = out.find((f) => f.tier === "high")!;
  const layoutOnly = out.find((f) => f.tier === "medium" && f.textEvidence === null)!;
  assert.equal(high.fieldKey, "company.biz_no");
  assert.ok(layoutOnly.label.includes("대표자"));
});

// --- 엣지 2: 동일 fieldKey text 2개 → dedup(1건) ---
check("엣지: 동일 fieldKey text 중복 → 1건만", () => {
  const text = textSet([
    textCand({ label: "기업명", fieldKey: "company.name", fillStrategy: "copy" }),
    textCand({ label: "기업명", fieldKey: "company.name", fillStrategy: "copy" }),
  ]);
  const out = reconcileFieldCandidates([text]);
  assert.equal(out.length, 1);
});

// --- 엣지 3: 라벨 불일치 → 매칭 실패, text-only + layout-only 병존 ---
check("엣지: 라벨 유사도 미달 → 매칭 실패(각자 독립 필드)", () => {
  const layout = layoutSet([
    layoutCand({ label: "전혀 다른 항목명", page: 1, bbox: [0.1, 0.1, 0.2, 0.05], confidence: 0.8 }),
  ]);
  const text = textSet([
    textCand({ label: "사업자등록번호", fieldKey: "company.biz_no", fillStrategy: "copy" }),
  ]);
  const out = reconcileFieldCandidates([layout, text]);
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.tier === "medium" || f.tier === "high"));
  assert.ok(out.some((f) => f.position !== null)); // layout-only 는 위치 有
  assert.ok(out.some((f) => f.position === null)); // text-only 는 위치 無
});

console.log(`\n✅ ${passed}개 통과`);
