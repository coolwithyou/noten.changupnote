import { parsePositionBbox, parsePositionPage, type NormalizedBox } from "@/lib/documents/bbox";
import { isReplaceableRhwpGuide, parseRhwpCellCharProperties } from "./guideText";

export interface RhwpFieldDescriptor {
  fieldId: string;
  fieldKey?: string | null;
  label: string;
  fieldType: string;
  sourceSpan?: string | null;
  position?: Record<string, unknown> | null;
  options?: readonly string[];
}

export interface RhwpCellTarget {
  kind: "cell";
  section: number;
  parentPara: number;
  controlIndex: number;
  cellIndex: number;
  cellParagraph: number;
  /** 입력 셀의 서식을 추정할 때 참고하는 왼쪽 라벨 셀. 직접 지정 앵커에는 없을 수 있다. */
  labelCellIndex?: number;
}

export interface RhwpChoiceAnchor {
  value: string;
  page: number;
  box: NormalizedBox;
  charOffset: number;
  length: number;
}

export interface RhwpFieldAppearance {
  fillColor?: string;
  maskTemplateText: boolean;
}

export interface RhwpFieldAnchor {
  fieldId: string;
  label: string;
  page: number;
  box: NormalizedBox;
  source: "rhwp_table_cell";
  confidence: "exact";
  target: RhwpCellTarget;
  choices: RhwpChoiceAnchor[];
  appearance?: RhwpFieldAppearance;
}

interface SearchHit {
  sec: number;
  length: number;
  charOffset?: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
    cellPara?: number;
  };
}

interface PageInfo {
  width: number;
  height: number;
}

interface CellBox {
  cellIdx: number;
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SelectionRect {
  pageIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  w?: number;
  h?: number;
}

export interface RhwpAnchorDocument {
  pageCount(): number;
  getPageInfo(page: number): string;
  getPageTextLayout?(page: number): string;
  searchAllText(query: string, caseSensitive: boolean, includeCells: boolean): string;
  getTableCellBboxes(
    section: number,
    parentPara: number,
    controlIndex: number,
    pageHint?: number | null,
  ): string;
  getSelectionRectsInCell?(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    startCellParagraph: number,
    startCharOffset: number,
    endCellParagraph: number,
    endCharOffset: number,
  ): string;
  getCellParagraphLength?(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
  ): number;
  getTextInCell?(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
    count: number,
  ): string;
  getCellCharPropertiesAt?(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
  ): string;
  getCellOwnProperties?(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
  ): string;
}

interface PageTextRun {
  text: string;
  secIdx: number;
  parentParaIdx?: number;
  controlIdx?: number;
  cellIdx?: number;
  cellParaIdx?: number;
  charStart?: number;
}

interface PageTextLayout {
  runs?: PageTextRun[];
}

interface PageControlCell {
  x: number;
  y: number;
  w: number;
  h: number;
  cellIdx: number;
}

interface PageTableControl {
  type: string;
  secIdx: number;
  paraIdx: number;
  controlIdx: number;
  cells?: PageControlCell[];
}

interface PageControlLayout {
  controls?: PageTableControl[];
}

export interface RhwpCellPickDocument {
  getPageInfo(page: number): string;
  getPageControlLayout(page: number): string;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parsePageInfo(value: string): PageInfo | null {
  try {
    const parsed = JSON.parse(value) as Partial<PageInfo>;
    return typeof parsed.width === "number" && parsed.width > 0
      && typeof parsed.height === "number" && parsed.height > 0
      ? parsed as PageInfo
      : null;
  } catch {
    return null;
  }
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

function textFromCellResult(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
      return (parsed as { text: string }).text;
    }
  } catch {
    // rhwp는 일반 문자열을 직접 반환하는 버전도 있다.
  }
  return value;
}

function cellAppearance(
  document: RhwpAnchorDocument,
  field: RhwpFieldDescriptor,
  target: RhwpCellTarget,
): RhwpFieldAppearance {
  let fillColor: string | undefined;
  if (document.getCellOwnProperties) {
    try {
      const own = JSON.parse(document.getCellOwnProperties(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.cellIndex,
      )) as { fillColor?: unknown };
      if (typeof own.fillColor === "string" && /^#[0-9a-f]{6}$/iu.test(own.fillColor)) {
        fillColor = own.fillColor;
      }
    } catch {
      // 셀 배경을 읽지 못하면 프리뷰의 기본 종이색을 사용한다.
    }
  }
  let maskTemplateText = false;
  if (document.getCellParagraphLength && document.getTextInCell && document.getCellCharPropertiesAt) {
    try {
      const length = document.getCellParagraphLength(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.cellIndex,
        target.cellParagraph,
      );
      if (length > 0) {
        const raw = textFromCellResult(document.getTextInCell(
          target.section,
          target.parentPara,
          target.controlIndex,
          target.cellIndex,
          target.cellParagraph,
          0,
          length,
        ));
        const visibleOffset = Math.max(0, raw.search(/\S/u));
        const properties = parseRhwpCellCharProperties(document.getCellCharPropertiesAt(
          target.section,
          target.parentPara,
          target.controlIndex,
          target.cellIndex,
          target.cellParagraph,
          visibleOffset,
        ));
        maskTemplateText = isReplaceableRhwpGuide(raw.trim(), field.sourceSpan, properties);
      }
    } catch {
      // 안내문 여부가 불확실하면 원본을 가리지 않는다.
    }
  }
  return {
    ...(fillColor ? { fillColor } : {}),
    maskTemplateText,
  };
}

function labelVariants(label: string): string[] {
  const trimmed = label.trim();
  const variants = [
    trimmed,
    trimmed.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(),
    trimmed.replace(/(팀원|구성원)\s*\d+/g, "$1").replace(/\s+/g, " ").trim(),
    trimmed.replace(/\s*표(?:\([^)]*\))?\s*$/u, "").trim(),
  ];
  return [...new Set(variants.filter((value) => normalizedText(value).length >= 2))];
}

/**
 * 한글 양식은 `성 명`, `성  명`처럼 글자 사이 공백으로 자간을 표현하는 경우가 많다.
 * searchAllText는 이를 문자 그대로 비교하므로, 페이지 레이아웃의 셀별 run을 합쳐
 * 공백·기호를 제거한 라벨이 같은 셀을 구조 검색의 보조 hit로 사용한다.
 */
function normalizedLayoutHits(
  document: RhwpAnchorDocument,
  query: string,
  hintPage: number | null,
  cellRunCache: Map<number, PageTextRun[][]>,
): SearchHit[] {
  if (!document.getPageTextLayout) return [];
  const queryText = normalizedText(query);
  if (queryText.length < 2) return [];
  const pageIndexes = hintPage
    ? [hintPage - 1]
    : Array.from({ length: document.pageCount() }, (_, index) => index);
  const hits: SearchHit[] = [];
  for (const pageIndex of pageIndexes) {
    if (!cellRunCache.has(pageIndex)) {
      let layout: PageTextLayout;
      try {
        layout = JSON.parse(document.getPageTextLayout(pageIndex)) as PageTextLayout;
      } catch {
        cellRunCache.set(pageIndex, []);
        continue;
      }
      const groupedRuns = new Map<string, PageTextRun[]>();
      for (const run of layout.runs ?? []) {
        if (!run.text || typeof run.secIdx !== "number"
          || typeof run.parentParaIdx !== "number"
          || typeof run.controlIdx !== "number"
          || typeof run.cellIdx !== "number") continue;
        const key = `${run.secIdx}:${run.parentParaIdx}:${run.controlIdx}:${run.cellIdx}:${run.cellParaIdx ?? 0}`;
        const runs = groupedRuns.get(key) ?? [];
        runs.push(run);
        groupedRuns.set(key, runs);
      }
      cellRunCache.set(pageIndex, [...groupedRuns.values()].map((runs) => (
        runs.sort((a, b) => (a.charStart ?? 0) - (b.charStart ?? 0))
      )));
    }
    for (const runs of cellRunCache.get(pageIndex) ?? []) {
      const cellText = runs.map((run) => run.text).join("");
      if (normalizedText(cellText) !== queryText) continue;
      const first = runs[0]!;
      hits.push({
        sec: first.secIdx,
        length: cellText.length,
        charOffset: first.charStart ?? 0,
        cellContext: {
          parentPara: first.parentParaIdx!,
          ctrlIdx: first.controlIdx!,
          cellIdx: first.cellIdx!,
          cellPara: first.cellParaIdx ?? 0,
        },
      });
    }
  }
  return hits;
}

function normalizeBox(box: { x: number; y: number; width: number; height: number }, page: PageInfo): NormalizedBox | null {
  const normalized = {
    x: box.x / page.width,
    y: box.y / page.height,
    width: box.width / page.width,
    height: box.height / page.height,
  };
  if (!Object.values(normalized).every(Number.isFinite)) return null;
  if (normalized.width <= 0 || normalized.height <= 0) return null;
  if (normalized.x < -0.001 || normalized.y < -0.001) return null;
  if (normalized.x + normalized.width > 1.001 || normalized.y + normalized.height > 1.001) return null;
  return normalized;
}

function rowOverlaps(a: CellBox, b: CellBox): boolean {
  const aEnd = a.row + (a.rowSpan ?? 1);
  const bEnd = b.row + (b.rowSpan ?? 1);
  return a.row < bEnd && b.row < aEnd;
}

function targetCellForLabel(labelCell: CellBox, cells: readonly CellBox[]): CellBox | null {
  const labelEnd = labelCell.col + (labelCell.colSpan ?? 1);
  return cells
    .filter((cell) => cell.pageIndex === labelCell.pageIndex && rowOverlaps(labelCell, cell) && cell.col >= labelEnd)
    .sort((a, b) => a.col - b.col || a.cellIdx - b.cellIdx)[0] ?? null;
}

function candidateDistance(box: NormalizedBox, hint: NormalizedBox | null): number {
  if (!hint) return 0;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hintX = hint.x + hint.width / 2;
  const hintY = hint.y + hint.height / 2;
  return Math.hypot(x - hintX, y - hintY);
}

function mergeRects(rects: readonly SelectionRect[], pageInfo: PageInfo): NormalizedBox | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + (rect.width ?? rect.w ?? 0)));
  const bottom = Math.max(...rects.map((rect) => rect.y + (rect.height ?? rect.h ?? 0)));
  // 선택 텍스트 왼쪽의 □/☐ glyph까지 클릭 영역에 포함한다.
  const glyphPadding = Math.min(14, x);
  return normalizeBox({ x: x - glyphPadding, y, width: right - x + glyphPadding, height: bottom - y }, pageInfo);
}

interface Candidate {
  anchor: RhwpFieldAnchor;
  score: number;
  key: string;
}

function choiceAnchors(
  document: RhwpAnchorDocument,
  field: RhwpFieldDescriptor,
  target: RhwpCellTarget,
  targetPageIndex: number,
  pageInfo: PageInfo,
): RhwpChoiceAnchor[] {
  if (!document.getSelectionRectsInCell || !field.options?.length) return [];
  const choices: RhwpChoiceAnchor[] = [];
  for (const value of field.options) {
    const matches = parseArray<SearchHit>(document.searchAllText(value, false, true))
      .filter((hit) => hit.cellContext
        && hit.sec === target.section
        && hit.cellContext.parentPara === target.parentPara
        && hit.cellContext.ctrlIdx === target.controlIndex
        && hit.cellContext.cellIdx === target.cellIndex);
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    const offset = match.charOffset ?? 0;
    const paragraph = match.cellContext?.cellPara ?? 0;
    const allRects = parseArray<SelectionRect>(document.getSelectionRectsInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      paragraph,
      offset,
      paragraph,
      offset + match.length,
    ));
    const rects = allRects.filter((rect) => rect.pageIndex === targetPageIndex);
    // 일부 rhwp 버전은 pageIndex 없이/다른 page hint로 rect를 돌려준다. 이때 전체 rect를 사용한다.
    const usableRects = rects.length > 0 ? rects : allRects;
    const box = mergeRects(usableRects, pageInfo);
    const pageIndex = usableRects[0]?.pageIndex;
    if (!box || typeof pageIndex !== "number") continue;
    choices.push({ value, page: pageIndex + 1, box, charOffset: offset, length: match.length });
  }
  return choices;
}

/**
 * 라벨 텍스트와 표 구조를 이용해 실제 입력 셀을 찾는다. 기존 DB bbox는 동률 후보를 구분하는
 * 힌트일 뿐이며 반환 좌표로 재사용하지 않는다.
 */
export function resolveRhwpFieldAnchors(
  document: RhwpAnchorDocument,
  fields: readonly RhwpFieldDescriptor[],
): RhwpFieldAnchor[] {
  const pageInfoCache = new Map<number, PageInfo | null>();
  const tableCache = new Map<string, CellBox[]>();
  const cellRunCache = new Map<number, PageTextRun[][]>();
  const pageInfoAt = (pageIndex: number): PageInfo | null => {
    if (!pageInfoCache.has(pageIndex)) {
      pageInfoCache.set(pageIndex, parsePageInfo(document.getPageInfo(pageIndex)));
    }
    return pageInfoCache.get(pageIndex) ?? null;
  };

  const resolved: RhwpFieldAnchor[] = [];
  for (const field of fields) {
    const hintPage = parsePositionPage(field.position);
    const hintBox = parsePositionBbox(field.position);
    const candidates = new Map<string, Candidate>();
    for (const [variantIndex, variant] of labelVariants(field.label).entries()) {
      const hits = [
        ...parseArray<SearchHit>(document.searchAllText(variant, false, true)),
        ...normalizedLayoutHits(document, variant, hintPage, cellRunCache),
      ];
      for (const hit of hits) {
        const context = hit.cellContext;
        if (!context || normalizedText(variant).length === 0 || hit.length < variant.length) continue;
        const tableKey = `${hit.sec}:${context.parentPara}:${context.ctrlIdx}:${hintPage ?? "all"}`;
        if (!tableCache.has(tableKey)) {
          tableCache.set(tableKey, parseArray<CellBox>(document.getTableCellBboxes(
            hit.sec,
            context.parentPara,
            context.ctrlIdx,
            hintPage ? hintPage - 1 : null,
          )));
        }
        const cells = tableCache.get(tableKey) ?? [];
        const labelCell = cells.find((cell) => cell.cellIdx === context.cellIdx);
        if (!labelCell) continue;
        const targetCell = targetCellForLabel(labelCell, cells);
        if (!targetCell) continue;
        const pageInfo = pageInfoAt(targetCell.pageIndex);
        if (!pageInfo) continue;
        const box = normalizeBox(
          { x: targetCell.x, y: targetCell.y, width: targetCell.w, height: targetCell.h },
          pageInfo,
        );
        if (!box) continue;
        const target: RhwpCellTarget = {
          kind: "cell",
          section: hit.sec,
          parentPara: context.parentPara,
          controlIndex: context.ctrlIdx,
          cellIndex: targetCell.cellIdx,
          cellParagraph: 0,
          labelCellIndex: labelCell.cellIdx,
        };
        const anchor: RhwpFieldAnchor = {
          fieldId: field.fieldId,
          label: field.label,
          page: targetCell.pageIndex + 1,
          box,
          source: "rhwp_table_cell",
          confidence: "exact",
          target,
          choices: choiceAnchors(document, field, target, targetCell.pageIndex, pageInfo),
        };
        const key = `${hit.sec}:${context.parentPara}:${context.ctrlIdx}:${targetCell.cellIdx}:${targetCell.pageIndex}`;
        const pageBonus = hintPage === anchor.page ? 100 : 0;
        const score = 1_000 - variantIndex * 100 + pageBonus - candidateDistance(box, hintBox) * 100;
        const previous = candidates.get(key);
        if (!previous || previous.score < score) candidates.set(key, { anchor, score, key });
      }
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    if (ranked.length === 0) continue;
    // 위치 힌트도 없고 동률에 가까운 후보가 둘이면 잘못 고르지 않는다.
    if (!hintPage && ranked[1] && Math.abs(ranked[0]!.score - ranked[1].score) < 1) continue;
    const selected = ranked[0]!.anchor;
    resolved.push({
      ...selected,
      appearance: cellAppearance(document, field, selected.target),
    });
  }
  return resolved;
}

/** 사용자가 rhwp 페이지에서 직접 누른 표 셀을 세션용 정확 앵커로 변환한다. */
export function resolveRhwpCellAtPoint(input: {
  document: RhwpCellPickDocument;
  field: RhwpFieldDescriptor;
  pageIndex: number;
  x: number;
  y: number;
}): RhwpFieldAnchor | null {
  const pageInfo = parsePageInfo(input.document.getPageInfo(input.pageIndex));
  if (!pageInfo) return null;
  let layout: PageControlLayout;
  try {
    layout = JSON.parse(input.document.getPageControlLayout(input.pageIndex)) as PageControlLayout;
  } catch {
    return null;
  }
  const candidates = (layout.controls ?? [])
    .filter((control) => control.type === "table")
    .flatMap((control) => (control.cells ?? []).map((cell) => ({ control, cell })))
    .filter(({ cell }) => input.x >= cell.x && input.x <= cell.x + cell.w
      && input.y >= cell.y && input.y <= cell.y + cell.h)
    .sort((a, b) => a.cell.w * a.cell.h - b.cell.w * b.cell.h);
  const picked = candidates[0];
  if (!picked) return null;
  const box = normalizeBox(
    { x: picked.cell.x, y: picked.cell.y, width: picked.cell.w, height: picked.cell.h },
    pageInfo,
  );
  if (!box) return null;
  return {
    fieldId: input.field.fieldId,
    label: input.field.label,
    page: input.pageIndex + 1,
    box,
    source: "rhwp_table_cell",
    confidence: "exact",
    target: {
      kind: "cell",
      section: picked.control.secIdx,
      parentPara: picked.control.paraIdx,
      controlIndex: picked.control.controlIdx,
      cellIndex: picked.cell.cellIdx,
      cellParagraph: 0,
    },
    choices: [],
  };
}
