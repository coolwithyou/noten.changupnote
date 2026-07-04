/**
 * 엔진별 원 좌표계 → 0~1 상대좌표(AABB) 정규화 + 원시 응답 → NormalizedFieldCandidate 변환.
 *
 * 단일 원천: 대조 문서 §4 정규화 변환표 / §5 어댑터 구현 주의점, 마스터 §8.4.
 *   | 후보      | 원 좌표계                 | 변환                                   | 함정 |
 *   |-----------|--------------------------|----------------------------------------|------|
 *   | Upstage   | 이미 0~1 (4점 {x,y})     | 4점→AABB min/max 만                    | 비직교(회전) 가능 |
 *   | Google    | normalizedVertices 0~1   | 그대로 사용                            | 좌표 0 은 JSON 에서 생략 → 누락키=0 보정 |
 *   | Azure     | polygon(이미지 px/PDF inch)| x/page.width, y/page.height           | page.unit 로 분모 단위 일치 확인 필수 |
 *   | PaddleOCR | px                       | 렌더 페이지 px 로 나눔                 | 렌더 DPI 정합 |
 *   | kordoc    | 없음(row/col)            | bbox:null                              | layout 열과 분리(text_parser) |
 *
 * 이 파일은 순수 함수만 둔다(네트워크 없음) — normalize.test.ts 픽스처 대상.
 */
import type { BBox, CandidateKind, NormalizedFieldCandidate } from "./types";

// ---------------------------------------------------------------------------
// 런타임 방어 접근자 (실 응답 스키마 변형에 견디도록)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// 기하: 4점/폴리곤 → AABB
// ---------------------------------------------------------------------------

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 0~1 좌표계의 점들을 감싸는 AABB. 비직교(회전) 사각형이면 min/max 로 감싼다(대조 §5-2).
 * 점이 없으면 null.
 */
export function pointsToAabb(points: ReadonlyArray<{ x: number; y: number }>): BBox | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = Number.isFinite(p.x) ? p.x : 0;
    const y = Number.isFinite(p.y) ? p.y : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = clamp01(minX);
  const y0 = clamp01(minY);
  const x1 = clamp01(maxX);
  const y1 = clamp01(maxY);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/** px/inch 등 절대 좌표 점들을 페이지 크기로 나눠 0~1 AABB 로 변환. */
export function scaledPointsToAabb(
  points: ReadonlyArray<{ x: number; y: number }>,
  divW: number,
  divH: number,
): BBox | null {
  if (!(divW > 0) || !(divH > 0)) return null;
  return pointsToAabb(points.map((p) => ({ x: p.x / divW, y: p.y / divH })));
}

// ---------------------------------------------------------------------------
// Upstage: coordinates = 페이지 대비 0~1 4점 (TL→TR→BR→BL). 변환 불필요, 4점→AABB.
// ---------------------------------------------------------------------------

const UPSTAGE_CATEGORY_KIND: Record<string, CandidateKind> = {
  table: "table_cell",
  figure: "instruction",
  chart: "instruction",
  equation: "instruction",
  heading1: "instruction",
  header: "instruction",
  footer: "instruction",
  caption: "instruction",
  footnote: "instruction",
  index: "instruction",
  paragraph: "text_input",
  list: "text_input",
};

function upstageContentText(content: unknown): string {
  const rec = asRecord(content);
  if (!rec) return asString(content);
  return asString(rec["text"]) || asString(rec["markdown"]) || asString(rec["html"]);
}

/**
 * Upstage Document Parse 응답 → 후보.
 * raw.elements[]: { category, page, coordinates:[{x,y}×4], content:{text|html|markdown}, id, ... }
 * @param pageOverride 단일 페이지 이미지 입력이므로 문서 실제 페이지 번호로 덮어쓴다.
 */
export function normalizeUpstage(raw: unknown, pageOverride: number): NormalizedFieldCandidate[] {
  const rec = asRecord(raw);
  const elements = asArray(rec?.["elements"]);
  const out: NormalizedFieldCandidate[] = [];
  for (const el of elements) {
    const e = asRecord(el);
    if (!e) continue;
    const coords = asArray(e["coordinates"])
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => c !== null)
      .map((c) => ({ x: asNumber(c["x"]) ?? 0, y: asNumber(c["y"]) ?? 0 }));
    const bbox = pointsToAabb(coords);
    const category = asString(e["category"]).toLowerCase();
    const text = upstageContentText(e["content"]);
    out.push({
      page: pageOverride,
      bbox,
      bboxSource: bbox ? "layout" : null,
      layer: "layout",
      kind: UPSTAGE_CATEGORY_KIND[category] ?? "unknown",
      label: text,
      text,
      confidence: asNumber(e["confidence"]),
      rotationDeg: null,
      raw: e,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Document AI (Form Parser): normalizedVertices 0~1, 좌표 0 은 JSON 생략(누락키=0 보정).
// ---------------------------------------------------------------------------

/** normalizedVertices([{x?,y?}]) → AABB. 누락 x/y 는 0(대조 §4 함정). */
export function googleNormalizedVerticesToAabb(vertices: unknown): BBox | null {
  const pts = asArray(vertices)
    .map((v) => asRecord(v))
    .filter((v): v is Record<string, unknown> => v !== null)
    // 0 생략 보정: 키가 없으면 0
    .map((v) => ({ x: asNumber(v["x"]) ?? 0, y: asNumber(v["y"]) ?? 0 }));
  return pointsToAabb(pts);
}

function googleLayoutBBox(layout: unknown): BBox | null {
  const l = asRecord(layout);
  const poly = asRecord(l?.["boundingPoly"]);
  if (!poly) return null;
  const nv = poly["normalizedVertices"];
  if (Array.isArray(nv) && nv.length > 0) return googleNormalizedVerticesToAabb(nv);
  return null;
}

/** textAnchor.textSegments → document.text 슬라이스. */
function googleAnchorText(layout: unknown, fullText: string): string {
  const l = asRecord(layout);
  const anchor = asRecord(l?.["textAnchor"]);
  const segs = asArray(anchor?.["textSegments"]);
  if (segs.length === 0) return "";
  let s = "";
  for (const seg of segs) {
    const r = asRecord(seg);
    if (!r) continue;
    const start = asNumber(r["startIndex"]) ?? 0;
    const end = asNumber(r["endIndex"]) ?? 0;
    if (end > start) s += fullText.slice(start, end);
  }
  return s.trim();
}

const GOOGLE_CHECKBOX_TYPES = new Set(["filled_checkbox", "unfilled_checkbox"]);

/**
 * Google Document AI(Form Parser) 응답 → 후보.
 * raw.document.{ text, pages[] }. pages[].{ formFields[], tables[], visualElements[] }.
 */
export function normalizeGoogleDocAI(raw: unknown, pageOverride: number): NormalizedFieldCandidate[] {
  const rec = asRecord(raw);
  const doc = asRecord(rec?.["document"]);
  const fullText = asString(doc?.["text"]);
  const pages = asArray(doc?.["pages"]);
  const out: NormalizedFieldCandidate[] = [];

  for (const pg of pages) {
    const p = asRecord(pg);
    if (!p) continue;

    // formFields → text_input (fieldValue 위치 우선, 없으면 fieldName)
    for (const ff of asArray(p["formFields"])) {
      const f = asRecord(ff);
      if (!f) continue;
      const nameText = googleAnchorText(f["fieldName"], fullText);
      const valueText = googleAnchorText(f["fieldValue"], fullText);
      const bbox = googleLayoutBBox(f["fieldValue"]) ?? googleLayoutBBox(f["fieldName"]);
      out.push({
        page: pageOverride,
        bbox,
        bboxSource: bbox ? "layout" : null,
        layer: "layout",
        kind: "text_input",
        label: nameText,
        text: valueText,
        confidence: asNumber(asRecord(f["fieldValue"])?.["confidence"] ?? asRecord(f["fieldName"])?.["confidence"]),
        rotationDeg: null,
        raw: f,
      });
    }

    // tables[].{headerRows,bodyRows}[].cells[] → table_cell
    for (const tb of asArray(p["tables"])) {
      const t = asRecord(tb);
      if (!t) continue;
      const rows = [...asArray(t["headerRows"]), ...asArray(t["bodyRows"])];
      for (const row of rows) {
        const r = asRecord(row);
        for (const cell of asArray(r?.["cells"])) {
          const c = asRecord(cell);
          if (!c) continue;
          const bbox = googleLayoutBBox(c["layout"]);
          const text = googleAnchorText(c["layout"], fullText);
          out.push({
            page: pageOverride,
            bbox,
            bboxSource: bbox ? "layout" : null,
            layer: "layout",
            kind: "table_cell",
            label: text,
            text,
            confidence: null,
            rotationDeg: null,
            raw: c,
          });
        }
      }
    }

    // visualElements → checkbox (filled/unfilled)
    for (const ve of asArray(p["visualElements"])) {
      const v = asRecord(ve);
      if (!v) continue;
      const type = asString(v["type"]).toLowerCase();
      if (!GOOGLE_CHECKBOX_TYPES.has(type)) continue;
      const bbox = googleLayoutBBox(v["layout"]);
      out.push({
        page: pageOverride,
        bbox,
        bboxSource: bbox ? "layout" : null,
        layer: "layout",
        kind: "checkbox",
        label: type,
        text: type,
        confidence: null,
        rotationDeg: null,
        raw: v,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Azure Document Intelligence (prebuilt-layout): polygon flat[8], 단위 = page.unit(px/inch).
//   → x/page.width, y/page.height. 분모는 page.unit 과 동일 단위이므로 상쇄된다(대조 §4).
// ---------------------------------------------------------------------------

/** polygon(flat [x1,y1,...x4,y4]) + 페이지 dims → AABB. divW/divH 는 page.unit 과 동일 단위. */
export function azurePolygonToAabb(polygon: unknown, divW: number, divH: number): BBox | null {
  const flat = asArray(polygon)
    .map((n) => asNumber(n))
    .filter((n): n is number => n !== null);
  if (flat.length < 8) return null;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pts.push({ x: flat[i] as number, y: flat[i + 1] as number });
  }
  return scaledPointsToAabb(pts, divW, divH);
}

type AzurePageDim = { width: number; height: number; unit: string; angle: number };

function azurePageDims(pages: unknown[]): Map<number, AzurePageDim> {
  const map = new Map<number, AzurePageDim>();
  for (const pg of pages) {
    const p = asRecord(pg);
    if (!p) continue;
    const pageNumber = asNumber(p["pageNumber"]) ?? 1;
    map.set(pageNumber, {
      width: asNumber(p["width"]) ?? 0,
      height: asNumber(p["height"]) ?? 0,
      // page.unit 분기: 이미지 입력="pixel", PDF/TIFF="inch". 분모 단위는 polygon 과 동일하므로 그대로 나눔.
      unit: asString(p["unit"]) || "pixel",
      angle: asNumber(p["angle"]) ?? 0,
    });
  }
  return map;
}

function azureBoundingRegionBBox(
  boundingRegions: unknown,
  dims: Map<number, AzurePageDim>,
): { bbox: BBox | null; rotationDeg: number | null } {
  const first = asRecord(asArray(boundingRegions)[0]);
  if (!first) return { bbox: null, rotationDeg: null };
  const pageNumber = asNumber(first["pageNumber"]) ?? 1;
  const dim = dims.get(pageNumber);
  if (!dim) return { bbox: null, rotationDeg: null };
  return { bbox: azurePolygonToAabb(first["polygon"], dim.width, dim.height), rotationDeg: dim.angle };
}

/**
 * Azure prebuilt-layout 응답 → 후보.
 * raw.analyzeResult.{ pages[]{ width,height,unit,angle, selectionMarks[] }, tables[]{ cells[] }, paragraphs[] }.
 */
export function normalizeAzureLayout(raw: unknown, pageOverride: number): NormalizedFieldCandidate[] {
  const rec = asRecord(raw);
  const result = asRecord(rec?.["analyzeResult"]) ?? rec; // 일부 SDK 는 result 를 최상위로 반환
  const pages = asArray(result?.["pages"]);
  const dims = azurePageDims(pages);
  const out: NormalizedFieldCandidate[] = [];

  // selection mark → checkbox (라벨 연결 없음, 후보만 — 대조 §5-4)
  for (const pg of pages) {
    const p = asRecord(pg);
    if (!p) continue;
    const pageNumber = asNumber(p["pageNumber"]) ?? 1;
    const dim = dims.get(pageNumber);
    for (const sm of asArray(p["selectionMarks"])) {
      const m = asRecord(sm);
      if (!m || !dim) continue;
      const bbox = azurePolygonToAabb(m["polygon"], dim.width, dim.height);
      const state = asString(m["state"]); // selected | unselected
      out.push({
        page: pageOverride,
        bbox,
        bboxSource: bbox ? "layout" : null,
        layer: "layout",
        kind: "checkbox",
        label: "",
        text: state,
        confidence: asNumber(m["confidence"]),
        rotationDeg: dim.angle,
        raw: m,
      });
    }
  }

  // tables[].cells[] → table_cell (병합 span 보존은 raw 에 남김)
  for (const tb of asArray(result?.["tables"])) {
    const t = asRecord(tb);
    if (!t) continue;
    for (const cell of asArray(t["cells"])) {
      const c = asRecord(cell);
      if (!c) continue;
      const { bbox, rotationDeg } = azureBoundingRegionBBox(c["boundingRegions"], dims);
      const text = asString(c["content"]);
      out.push({
        page: pageOverride,
        bbox,
        bboxSource: bbox ? "layout" : null,
        layer: "layout",
        kind: "table_cell",
        label: text,
        text,
        confidence: null,
        rotationDeg,
        raw: c,
      });
    }
  }

  // paragraphs[] → text_input (레이아웃 텍스트 블록)
  for (const pr of asArray(result?.["paragraphs"])) {
    const par = asRecord(pr);
    if (!par) continue;
    const { bbox, rotationDeg } = azureBoundingRegionBBox(par["boundingRegions"], dims);
    const text = asString(par["content"]);
    out.push({
      page: pageOverride,
      bbox,
      bboxSource: bbox ? "layout" : null,
      layer: "layout",
      kind: "text_input",
      label: text,
      text,
      confidence: null,
      rotationDeg,
      raw: par,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// PaddleOCR PP-StructureV3: layout/table box(px) + label + score. px → 렌더 페이지 px 로 나눔.
//   canonical 중간표현 { boxes:[{bbox:[x1,y1,x2,y2](px), label, score}], imageWidth, imageHeight }
//   (fetch 단계에서 서버 응답을 이 형태로 어댑팅 — 스키마 불일치 시 어댑터가 명확한 에러)
// ---------------------------------------------------------------------------

const PADDLE_LABEL_KIND: Record<string, CandidateKind> = {
  table: "table_cell",
  table_cell: "table_cell",
  text: "text_input",
  list: "text_input",
  reference: "text_input",
  paragraph_title: "instruction",
  doc_title: "instruction",
  title: "instruction",
  header: "instruction",
  footer: "instruction",
  figure: "instruction",
  figure_title: "instruction",
  image: "instruction",
  formula: "instruction",
  equation: "instruction",
  seal: "stamp",
  stamp: "stamp",
};

/** PaddleOCR canonical 중간표현 → 후보. box=[x1,y1,x2,y2] px, imageWidth/Height px. */
export function normalizePaddleStructure(raw: unknown, pageOverride: number): NormalizedFieldCandidate[] {
  const rec = asRecord(raw);
  const w = asNumber(rec?.["imageWidth"]) ?? 0;
  const h = asNumber(rec?.["imageHeight"]) ?? 0;
  const out: NormalizedFieldCandidate[] = [];
  for (const b of asArray(rec?.["boxes"])) {
    const box = asRecord(b);
    if (!box) continue;
    const coord = asArray(box["bbox"])
      .map((n) => asNumber(n))
      .filter((n): n is number => n !== null);
    let bbox: BBox | null = null;
    if (coord.length >= 4 && w > 0 && h > 0) {
      const x1 = coord[0] as number;
      const y1 = coord[1] as number;
      const x2 = coord[2] as number;
      const y2 = coord[3] as number;
      bbox = pointsToAabb([
        { x: x1 / w, y: y1 / h },
        { x: x2 / w, y: y2 / h },
      ]);
    }
    const label = asString(box["label"]).toLowerCase();
    const text = asString(box["text"]);
    out.push({
      page: pageOverride,
      bbox,
      bboxSource: bbox ? "layout" : null,
      layer: "layout",
      kind: PADDLE_LABEL_KIND[label] ?? "unknown",
      label: text || label,
      text,
      confidence: asNumber(box["score"]),
      rotationDeg: null,
      raw: box,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// kordoc (text parser, §8.5): bbox 없음(row/col 논리 인덱스만). page:null, bbox:null 후보.
//   canonical raw { engine:"kordoc", version, confidence, fields:[{label,value,row,col,fieldType}] }
//   (fetch 단계에서 inferFieldType 으로 fieldType 을 부여 — normalize 는 kordoc 의존 없음)
// ---------------------------------------------------------------------------

const KORDOC_FIELDTYPE_KIND: Record<string, CandidateKind> = {
  checkbox: "checkbox",
  date: "text_input",
  phone: "text_input",
  email: "text_input",
  amount: "text_input",
  idnum: "text_input",
  text: "text_input",
};

/** kordoc extractFormFields 결과(어댑터가 fieldType 부여) → 후보. bbox:null, page:null, layer=text_parser. */
export function normalizeKordoc(raw: unknown): NormalizedFieldCandidate[] {
  const rec = asRecord(raw);
  const confidence = asNumber(rec?.["confidence"]);
  const out: NormalizedFieldCandidate[] = [];
  for (const f of asArray(rec?.["fields"])) {
    const field = asRecord(f);
    if (!field) continue;
    const label = asString(field["label"]);
    const value = asString(field["value"]);
    const fieldType = asString(field["fieldType"]).toLowerCase();
    out.push({
      page: null,
      bbox: null,
      bboxSource: "text_parser",
      layer: "text_parser",
      kind: KORDOC_FIELDTYPE_KIND[fieldType] ?? "text_input",
      label,
      text: value,
      confidence,
      rotationDeg: null,
      raw: field,
    });
  }
  return out;
}
