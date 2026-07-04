/**
 * normalize.ts / metrics.ts 픽스처 단위 테스트 (node:assert, tsx 실행).
 *
 * 사용: pnpm eval:layout:test
 *
 * 픽스처는 각 엔진의 **문서화된 응답 스키마 기반 합성(synthetic) JSON** 이다(실 API 응답 아님).
 * 대조 문서 §2~§5 의 스키마 사실에 맞춰 손으로 구성했으며, 실호출 없이 정규화 경로만 검증한다.
 * 핵심 커버: 4점 비직교 AABB / Google 0 생략 보정 / Azure page.unit 분기(px·inch).
 */
import assert from "node:assert/strict";
import {
  azurePolygonToAabb,
  clamp01,
  googleNormalizedVerticesToAabb,
  normalizeAzureLayout,
  normalizeGoogleDocAI,
  normalizeKordoc,
  normalizePaddleStructure,
  normalizeUpstage,
  pointsToAabb,
} from "./normalize";
import {
  diceBigram,
  extractGoldenFields,
  iou,
  labelSimilarity,
  tallyDoc,
} from "./metrics";
import type { NormalizedFieldCandidate } from "./types";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function approx(a: number, b: number, eps = 1e-9): void {
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} 아님`);
}
function approxBox(a: readonly number[] | null, b: readonly number[]): void {
  assert.ok(a !== null, "bbox null 아님");
  const box = a as readonly number[];
  for (let i = 0; i < 4; i++) approx(box[i] as number, b[i] as number, 1e-6);
}

console.log("layout-eval 정규화/메트릭 단위 테스트\n");

// --- 기하: 4점 비직교(회전) → min/max AABB ---
check("pointsToAabb: 비직교 4점 → 감싸는 AABB", () => {
  // 회전으로 비스듬한 사각형(TL→TR→BR→BL 순서가 흐트러진 경우)
  const box = pointsToAabb([
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.15 },
    { x: 0.95, y: 0.8 },
    { x: 0.05, y: 0.85 },
  ]);
  approxBox(box, [0.05, 0.15, 0.9, 0.7]);
});

check("clamp01: 범위 밖 클램프", () => {
  assert.equal(clamp01(-0.3), 0);
  assert.equal(clamp01(1.4), 1);
  assert.equal(clamp01(0.5), 0.5);
});

// --- Google: normalizedVertices 0 생략 보정 ---
check("googleNormalizedVerticesToAabb: 0 좌표 생략(누락키=0) 보정", () => {
  // 좌상단 (0,0) 의 x,y 가 JSON 에서 생략된 형태
  const box = googleNormalizedVerticesToAabb([
    { y: 0.0 }, // x 생략 → 0
    { x: 0.5, y: 0.0 },
    { x: 0.5, y: 0.2 },
    { y: 0.2 }, // x 생략 → 0
  ]);
  approxBox(box, [0, 0, 0.5, 0.2]);
});

// --- Azure: page.unit 분기 (이미지 px vs PDF inch) 가 동일 0~1 로 수렴 ---
check("azurePolygonToAabb: px 페이지와 inch 페이지가 같은 0~1 로 정규화", () => {
  // 페이지의 10%~30% 위치 사각형
  const pxBox = azurePolygonToAabb(
    [122.4, 158.4, 367.2, 158.4, 367.2, 475.2, 122.4, 475.2], // px
    1224,
    1584,
  );
  const inchBox = azurePolygonToAabb(
    [0.85, 1.1, 2.55, 1.1, 2.55, 3.3, 0.85, 3.3], // inch
    8.5,
    11,
  );
  approxBox(pxBox, [0.1, 0.1, 0.2, 0.2]);
  approxBox(inchBox, [0.1, 0.1, 0.2, 0.2]);
});

// --- Upstage 정규화 (coordinates 0~1 4점) ---
check("normalizeUpstage: element coordinates 0~1 → 후보", () => {
  // 문서화 스키마(대조 §3.1) 기반 합성
  const raw = {
    elements: [
      {
        id: 0,
        category: "paragraph",
        page: 1,
        coordinates: [
          { x: 0.0714, y: 0.1509 },
          { x: 0.9627, y: 0.1509 },
          { x: 0.9627, y: 0.2 },
          { x: 0.0714, y: 0.2 },
        ],
        content: { text: "사업자등록번호" },
      },
      { id: 1, category: "table", page: 1, coordinates: [{ x: 0.1, y: 0.3 }, { x: 0.9, y: 0.3 }, { x: 0.9, y: 0.5 }, { x: 0.1, y: 0.5 }], content: { text: "자금신청금액" } },
    ],
  };
  const cands = normalizeUpstage(raw, 7);
  assert.equal(cands.length, 2);
  assert.equal(cands[0]?.page, 7); // pageOverride 적용
  assert.equal(cands[0]?.kind, "text_input");
  assert.equal(cands[0]?.layer, "layout");
  approxBox(cands[0]?.bbox ?? null, [0.0714, 0.1509, 0.8913, 0.0491]);
  assert.equal(cands[1]?.kind, "table_cell");
});

// --- Google 정규화 (formFields + table + visualElements) ---
check("normalizeGoogleDocAI: formField/table/checkbox → 후보", () => {
  const raw = {
    document: {
      text: "대표자 성명홍길동",
      pages: [
        {
          formFields: [
            {
              fieldName: { textAnchor: { textSegments: [{ startIndex: 0, endIndex: 6 }] } },
              fieldValue: {
                textAnchor: { textSegments: [{ startIndex: 6, endIndex: 9 }] },
                confidence: 0.98,
                boundingPoly: { normalizedVertices: [{ x: 0.3, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.23 }, { x: 0.3, y: 0.23 }] },
              },
            },
          ],
          tables: [
            {
              bodyRows: [
                { cells: [{ layout: { textAnchor: { textSegments: [{ startIndex: 0, endIndex: 6 }] }, boundingPoly: { normalizedVertices: [{ y: 0.5 }, { x: 0.4, y: 0.5 }, { x: 0.4, y: 0.55 }, { y: 0.55 }] } } }] },
              ],
            },
          ],
          visualElements: [
            { type: "filled_checkbox", layout: { boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.7 }, { x: 0.12, y: 0.7 }, { x: 0.12, y: 0.72 }, { x: 0.1, y: 0.72 }] } } },
          ],
        },
      ],
    },
  };
  const cands = normalizeGoogleDocAI(raw, 2);
  const kinds = cands.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["checkbox", "table_cell", "text_input"]);
  const ff = cands.find((c) => c.kind === "text_input");
  assert.equal(ff?.label, "대표자 성명");
  assert.equal(ff?.text, "홍길동");
  assert.equal(ff?.confidence, 0.98);
  approxBox(ff?.bbox ?? null, [0.3, 0.2, 0.3, 0.03]);
  // table cell 은 normalizedVertices 의 x 생략(0) 보정
  approxBox(cands.find((c) => c.kind === "table_cell")?.bbox ?? null, [0, 0.5, 0.4, 0.05]);
});

// --- Azure 정규화 (선택마크/셀/문단, 이미지 px 페이지) ---
check("normalizeAzureLayout: selectionMark/cell/paragraph → 후보 (px 페이지)", () => {
  const raw = {
    analyzeResult: {
      pages: [
        {
          pageNumber: 1,
          width: 1000,
          height: 1000,
          unit: "pixel",
          angle: 0,
          selectionMarks: [
            { state: "selected", confidence: 0.9, polygon: [100, 100, 140, 100, 140, 140, 100, 140] },
          ],
        },
      ],
      tables: [
        {
          cells: [
            { content: "성명", boundingRegions: [{ pageNumber: 1, polygon: [200, 200, 400, 200, 400, 260, 200, 260] }] },
          ],
        },
      ],
      paragraphs: [
        { content: "신청서", boundingRegions: [{ pageNumber: 1, polygon: [50, 50, 300, 50, 300, 90, 50, 90] }] },
      ],
    },
  };
  const cands = normalizeAzureLayout(raw, 1);
  const checkbox = cands.find((c) => c.kind === "checkbox");
  assert.equal(checkbox?.text, "selected");
  assert.equal(checkbox?.label, ""); // 라벨 연결 안 함
  approxBox(checkbox?.bbox ?? null, [0.1, 0.1, 0.04, 0.04]);
  assert.equal(cands.find((c) => c.kind === "table_cell")?.text, "성명");
  assert.equal(cands.find((c) => c.kind === "text_input")?.text, "신청서");
});

// --- PaddleOCR 정규화 (canonical px → 0~1) ---
check("normalizePaddleStructure: box px → 0~1", () => {
  const raw = {
    imageWidth: 1000,
    imageHeight: 2000,
    boxes: [
      { bbox: [100, 200, 500, 400], label: "table", score: 0.95, text: "" },
      { bbox: [100, 500, 900, 560], label: "text", score: 0.9, text: "성명" },
    ],
  };
  const cands = normalizePaddleStructure(raw, 3);
  assert.equal(cands[0]?.kind, "table_cell");
  approxBox(cands[0]?.bbox ?? null, [0.1, 0.1, 0.4, 0.1]);
  assert.equal(cands[1]?.kind, "text_input");
  assert.equal(cands[1]?.page, 3);
});

// --- kordoc 정규화 (bbox 없음, text_parser) ---
check("normalizeKordoc: bbox:null, page:null, layer=text_parser", () => {
  const raw = {
    engine: "kordoc",
    version: "3.13.0",
    confidence: 0.8,
    fields: [
      { label: "성명", value: "홍길동", row: 0, col: 1, fieldType: "text" },
      { label: "동의 여부", value: "□", row: 3, col: 0, fieldType: "checkbox" },
    ],
  };
  const cands = normalizeKordoc(raw);
  assert.equal(cands.length, 2);
  assert.equal(cands[0]?.bbox, null);
  assert.equal(cands[0]?.page, null);
  assert.equal(cands[0]?.layer, "text_parser");
  assert.equal(cands[0]?.bboxSource, "text_parser");
  assert.equal(cands[1]?.kind, "checkbox");
});

// --- metrics: iou / labelSimilarity / tallyDoc ---
check("iou: 반쪽 겹침", () => {
  // a=[0,0,1,1], b=[0.5,0,1,1] 교집합 0.5, 합집합 1.5 → 1/3
  approx(iou([0, 0, 1, 1], [0.5, 0, 1, 1]), 1 / 3, 1e-9);
  assert.equal(iou([0, 0, 0.1, 0.1], [0.9, 0.9, 0.1, 0.1]), 0);
});

check("labelSimilarity: 동일=1, 상이=낮음", () => {
  assert.equal(labelSimilarity("사업자등록번호", "사업자등록번호"), 1);
  assert.ok(labelSimilarity("사업자등록번호", "공장등록번호") < 0.7);
  assert.ok(diceBigram("", "") === 0);
});

check("tallyDoc: coverage + manual recall (IoU/label 매칭)", () => {
  const gold = {
    fields: [
      { label: "사업자등록번호", type: "text", page: 1, bbox: [0.28, 0.16, 0.15, 0.04], manual: false },
      { label: "대표자 (인)", type: "signature", page: 1, bbox: [0.2, 0.57, 0.3, 0.03], manual: true },
      { label: "개인정보 동의", type: "checkbox", page: 2, bbox: [0.1, 0.8, 0.7, 0.06], manual: true },
    ],
  };
  const goldenFields = extractGoldenFields(gold);
  assert.equal(goldenFields.length, 3);

  const candidates: NormalizedFieldCandidate[] = [
    // label 매칭(kordoc 류): 사업자등록번호
    { page: null, bbox: null, bboxSource: "text_parser", layer: "text_parser", kind: "text_input", label: "사업자등록번호", text: "", confidence: null, rotationDeg: null, raw: {} },
    // IoU 매칭: 서명란(page 1, 위치 근접)
    { page: 1, bbox: [0.2, 0.57, 0.3, 0.03], bboxSource: "layout", layer: "layout", kind: "signature", label: "", text: "", confidence: null, rotationDeg: null, raw: {} },
    // page 2 동의는 커버 안 함
  ];
  const t = tallyDoc(goldenFields, candidates);
  assert.equal(t.goldenFields, 3);
  assert.equal(t.matchedFields, 2); // 사업자등록번호(label) + 서명(IoU)
  assert.equal(t.manualGoldenFields, 2); // 서명 + 동의
  assert.equal(t.manualMatched, 1); // 서명만
});

console.log(`\n✅ ${passed}개 통과`);
