import type { RhwpDocument, RhwpDocumentFormat, RhwpModule } from "./client";
import { exportVerifiedRhwpDocument } from "./client";
import { canonicalSha256, sha256Hex } from "./documentAgentContract";
import { parseRhwpCellCharProperties, type RhwpCellCharProperties } from "./guideText";
import { scheduleTablePlanSchema, type SchedulePhase, type ScheduleTablePlan } from "./scheduleTableContract";

const CONTENT_HEADER = "추진내용";
const MAX_BODY_ROWS = 8;
const FILL_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const BORDER_FILL_KEYS = [
  "borderLeft",
  "borderRight",
  "borderTop",
  "borderBottom",
  "fillType",
  "fillColor",
  "patternColor",
  "patternType",
  "diagonalLine",
  "diagonalSlash",
  "diagonalBackSlash",
  "diagonalWidth",
  "diagonalColor",
  "centerLine",
] as const;
const FILL_KEYS = ["fillType", "fillColor", "patternColor", "patternType"] as const;

interface SearchHit {
  sec: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
    cellPara?: number;
  };
}

interface TableDimensions {
  rowCount: number;
  colCount: number;
  cellCount: number;
}

interface CellInfo {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

interface CellCoordinate extends CellInfo {
  cellIndex: number;
}

export interface ScheduleTableRowBinding {
  row: number;
  titleCellIndex: number;
  title: string;
  titleCharProperties: RhwpCellCharProperties | null;
  monthCellIndices: number[];
  monthFillColors: string[];
  monthCellStyles: Array<Record<string, unknown>>;
}

export interface ScheduleTableTarget {
  schemaVersion: 1;
  documentSha256: string;
  page: number | null;
  anchor: {
    section: number;
    parentPara: number;
    controlIndex: number;
    headerRow: number;
    titleColumn: number;
  };
  months: number[];
  rows: ScheduleTableRowBinding[];
  activeFillColor: string;
  inactiveFillColor: string;
  activeFillStyle: Record<string, unknown>;
  inactiveFillStyle: Record<string, unknown>;
  structureSha256: string;
  preimageSha256: string;
}

export type ScheduleTableInspection =
  | { status: "unique"; target: ScheduleTableTarget }
  | { status: "missing" | "ambiguous" | "unsupported"; message: string };

export interface ScheduleTableApplyResult {
  bytes: Uint8Array;
  beforeDocumentSha256: string;
  afterDocumentSha256: string;
  pageCount: number;
  target: ScheduleTableTarget;
}

export class ScheduleTableVerificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ScheduleTableVerificationError";
  }
}

/**
 * 일정표 후보 탐색과 exact 구조 판정을 한 모듈 안에 둔다. 호출자는 셀 좌표나 서식 규칙을 조립하지 않는다.
 */
export async function inspectScheduleTableDocument(
  document: RhwpDocument,
  documentSha256: string,
  styleReference?: Pick<ScheduleTableTarget, "activeFillColor" | "inactiveFillColor" | "activeFillStyle" | "inactiveFillStyle">,
): Promise<ScheduleTableInspection> {
  const hits = uniqueTableHits(document);
  const candidates: ScheduleTableTarget[] = [];
  let unsupportedReason: string | null = null;

  for (const hit of hits) {
    try {
      const candidate = await inspectCandidate(document, documentSha256, hit, styleReference);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      unsupportedReason ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (candidates.length === 1) return { status: "unique", target: candidates[0]! };
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      message: "'추진내용' 월별 일정표가 문서에 둘 이상 있어 자동으로 대상을 고를 수 없습니다.",
    };
  }
  if (unsupportedReason) return { status: "unsupported", message: unsupportedReason };
  return {
    status: "missing",
    message: "'추진내용'과 연속된 월 머리글을 가진 일정표를 문서에서 찾지 못했습니다.",
  };
}

export async function applyScheduleTablePlan(input: {
  rhwp: RhwpModule;
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  target: ScheduleTableTarget;
  plan: ScheduleTablePlan;
}): Promise<ScheduleTableApplyResult> {
  const plan = validatePlanForTarget(input.plan, input.target);
  const beforeDocumentSha256 = await sha256Hex(input.bytes);
  if (beforeDocumentSha256 !== input.target.documentSha256) {
    throw new ScheduleTableVerificationError("일정안을 만든 뒤 문서가 변경되었습니다. 현재 문서에서 일정안을 다시 만들어 주세요.");
  }

  const document = new input.rhwp.HwpDocument(input.bytes);
  try {
    const before = await inspectScheduleTableDocument(document, beforeDocumentSha256);
    if (before.status !== "unique") {
      throw new ScheduleTableVerificationError(before.message);
    }
    if (
      before.target.structureSha256 !== input.target.structureSha256
      || before.target.preimageSha256 !== input.target.preimageSha256
    ) {
      throw new ScheduleTableVerificationError("일정표의 구조·내용·색상이 미리보기 시점과 달라 반영을 차단했습니다.");
    }

    const pageCountBefore = document.pageCount();
    mutateScheduleTable(document, before.target, plan.phases);
    const verification = exportVerifiedRhwpDocument({
      rhwp: input.rhwp,
      document,
      format: input.format,
    });
    if (verification.pageCountAfter !== pageCountBefore) {
      throw new ScheduleTableVerificationError("일정표 반영 뒤 문서 페이지 수가 달라져 저장을 차단했습니다.");
    }
    const afterDocumentSha256 = await sha256Hex(verification.bytes);
    const reopened = new input.rhwp.HwpDocument(verification.bytes);
    try {
      const after = await inspectScheduleTableDocument(reopened, afterDocumentSha256, before.target);
      if (after.status !== "unique") {
        throw new ScheduleTableVerificationError("내보낸 문서에서 일정표를 다시 하나로 확정하지 못했습니다.");
      }
      if (after.target.structureSha256 !== before.target.structureSha256) {
        throw new ScheduleTableVerificationError("일정표 반영 뒤 표 구조가 달라졌습니다.");
      }
      assertSchedulePostimage(before.target, after.target, plan.phases);
      return {
        bytes: verification.bytes,
        beforeDocumentSha256,
        afterDocumentSha256,
        pageCount: verification.pageCountAfter,
        target: after.target,
      };
    } finally {
      reopened.free();
    }
  } catch (error) {
    if (error instanceof ScheduleTableVerificationError) throw error;
    throw new ScheduleTableVerificationError("일정표 반영 결과를 검증하지 못했습니다.", error);
  } finally {
    document.free();
  }
}

function uniqueTableHits(document: RhwpDocument): Array<Required<SearchHit>> {
  const byKey = new Map<string, Required<SearchHit>>();
  for (const query of ["추진내용", "추진 내용"]) {
    const hits = parseJsonArray<SearchHit>(document.searchAllText(query, false, true));
    for (const hit of hits) {
      if (!hit.cellContext) continue;
      const value = hit as Required<SearchHit>;
      const key = `${hit.sec}:${hit.cellContext.parentPara}:${hit.cellContext.ctrlIdx}`;
      if (!byKey.has(key)) byKey.set(key, value);
    }
  }
  return [...byKey.values()];
}

async function inspectCandidate(
  document: RhwpDocument,
  documentSha256: string,
  hit: Required<SearchHit>,
  styleReference?: Pick<ScheduleTableTarget, "activeFillColor" | "inactiveFillColor" | "activeFillStyle" | "inactiveFillStyle">,
): Promise<ScheduleTableTarget | null> {
  const section = hit.sec;
  const parentPara = hit.cellContext.parentPara;
  const controlIndex = hit.cellContext.ctrlIdx;
  const dimensions = parseJsonObject<TableDimensions>(
    document.getTableDimensions(section, parentPara, controlIndex),
  );
  if (!validDimensions(dimensions)) return null;

  const cells: CellCoordinate[] = [];
  for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
    const info = parseJsonObject<CellInfo>(document.getCellInfo(section, parentPara, controlIndex, cellIndex));
    if (!info || !Number.isInteger(info.row) || !Number.isInteger(info.col)) continue;
    cells.push({
      cellIndex,
      row: info.row,
      col: info.col,
      rowSpan: info.rowSpan ?? 1,
      colSpan: info.colSpan ?? 1,
    });
  }
  const byCoordinate = new Map(cells.map((cell) => [`${cell.row}:${cell.col}`, cell]));
  const headerCell = cells.find((cell) => cell.cellIndex === hit.cellContext.cellIdx);
  if (!headerCell || normalizeCellText(readSingleParagraph(document, section, parentPara, controlIndex, headerCell.cellIndex).text) !== CONTENT_HEADER) {
    return null;
  }
  if (headerCell.rowSpan !== 1 || headerCell.colSpan !== 1) {
    throw new Error("일정표의 '추진내용' 머리글이 병합 셀이라 안전한 자동 입력을 지원하지 않습니다.");
  }

  const monthCells: Array<{ month: number; cell: CellCoordinate }> = [];
  for (let col = headerCell.col + 1; col < dimensions.colCount; col += 1) {
    const cell = byCoordinate.get(`${headerCell.row}:${col}`);
    if (!cell) break;
    const value = normalizeCellText(readSingleParagraph(document, section, parentPara, controlIndex, cell.cellIndex).text);
    const match = /^(1[0-2]|[1-9])월$/u.exec(value);
    if (!match) break;
    monthCells.push({ month: Number(match[1]), cell });
  }
  if (monthCells.length < 3 || new Set(monthCells.map((entry) => entry.month)).size !== monthCells.length) return null;
  if (monthCells.some((entry, index) => index > 0 && entry.month !== monthCells[index - 1]!.month + 1)) {
    throw new Error("일정표의 월 머리글이 같은 해 안에서 연속 증가하지 않아 자동 입력을 지원하지 않습니다.");
  }
  if (monthCells.some(({ cell }) => cell.rowSpan !== 1 || cell.colSpan !== 1)) {
    throw new Error("일정표의 월 머리글에 병합 셀이 있어 안전한 자동 입력을 지원하지 않습니다.");
  }
  if (dimensions.rowCount - headerCell.row - 1 > MAX_BODY_ROWS) {
    throw new Error(`일정표 본문이 ${MAX_BODY_ROWS}행을 넘어 자동 입력 범위를 확정하지 못했습니다.`);
  }

  const rows: ScheduleTableRowBinding[] = [];
  for (let row = headerCell.row + 1; row < dimensions.rowCount && rows.length < MAX_BODY_ROWS; row += 1) {
    const titleCell = byCoordinate.get(`${row}:${headerCell.col}`);
    const rowMonthCells = monthCells.map(({ cell }) => byCoordinate.get(`${row}:${cell.col}`) ?? null);
    if (!titleCell || rowMonthCells.some((cell) => !cell)) break;
    const allCells = [titleCell, ...rowMonthCells] as CellCoordinate[];
    if (allCells.some((cell) => cell.rowSpan !== 1 || cell.colSpan !== 1)) {
      throw new Error("일정표 본문에 병합 셀이 있어 안전한 자동 입력을 지원하지 않습니다.");
    }
    const titleEvidence = readSingleParagraph(document, section, parentPara, controlIndex, titleCell.cellIndex);
    const monthCellStyles = rowMonthCells.map((cell) => readBorderFillStyle(
      document,
      section,
      parentPara,
      controlIndex,
      cell!.cellIndex,
    ));
    const monthFillColors = monthCellStyles.map(readStyleFillColor);
    rows.push({
      row,
      titleCellIndex: titleCell.cellIndex,
      title: titleEvidence.text,
      titleCharProperties: titleEvidence.charProperties,
      monthCellIndices: rowMonthCells.map((cell) => cell!.cellIndex),
      monthFillColors,
      monthCellStyles,
    });
  }
  if (rows.length < 1) throw new Error("일정표에 자동 입력할 본문 행이 없습니다.");

  let inactiveFillColor: string;
  let activeFillColor: string;
  let inactiveFillStyle: Record<string, unknown>;
  let activeFillStyle: Record<string, unknown>;
  if (styleReference) {
    inactiveFillColor = styleReference.inactiveFillColor;
    activeFillColor = styleReference.activeFillColor;
    inactiveFillStyle = styleReference.inactiveFillStyle;
    activeFillStyle = styleReference.activeFillStyle;
  } else {
    const colors = rows.flatMap((row) => row.monthFillColors);
    const colorCounts = new Map<string, number>();
    for (const color of colors) colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
    if (colorCounts.size !== 2) {
      throw new Error("일정표의 활성·비활성 배경색 두 가지를 예시 셀에서 확정하지 못했습니다.");
    }
    const rankedColors = [...colorCounts.entries()].sort((left, right) => right[1] - left[1]);
    const neutralColors = rankedColors.filter(([color]) => isNeutralWhite(color));
    if (neutralColors.length === 1) {
      inactiveFillColor = neutralColors[0]![0];
      activeFillColor = rankedColors.find(([color]) => color !== inactiveFillColor)![0];
    } else {
      if (rankedColors[0]![1] === rankedColors[1]![1]) {
        throw new Error("일정표의 활성·비활성 배경색 사용 빈도가 같아 서식을 임의로 고르지 않습니다.");
      }
      inactiveFillColor = rankedColors[0]![0];
      activeFillColor = rankedColors[1]![0];
    }
    inactiveFillStyle = uniqueFillStyle(rows, inactiveFillColor);
    activeFillStyle = uniqueFillStyle(rows, activeFillColor);
  }
  const geometry = tableGeometry(document, section, parentPara, controlIndex);
  if (geometry.length === 0) throw new Error("일정표의 페이지 배치 좌표를 확인하지 못했습니다.");
  const page = geometry[0]!.pageIndex + 1;
  const structureProjection = {
    anchor: { section, parentPara, controlIndex, headerRow: headerCell.row, titleColumn: headerCell.col },
    months: monthCells.map((entry) => entry.month),
    geometry,
    rows: rows.map((row) => ({
      row: row.row,
      titleCellIndex: row.titleCellIndex,
      monthCellIndices: row.monthCellIndices,
    })),
  };
  const preimageProjection = {
    ...structureProjection,
    activeFillColor,
    inactiveFillColor,
    activeFillStyle,
    inactiveFillStyle,
    rows: rows.map((row) => ({
      row: row.row,
      titleCellIndex: row.titleCellIndex,
      title: row.title,
      titleCharProperties: row.titleCharProperties,
      monthCellIndices: row.monthCellIndices,
      monthFillColors: row.monthFillColors,
      monthCellStyles: row.monthCellStyles,
    })),
  };
  return {
    schemaVersion: 1,
    documentSha256,
    page,
    anchor: structureProjection.anchor,
    months: structureProjection.months,
    rows,
    activeFillColor,
    inactiveFillColor,
    activeFillStyle,
    inactiveFillStyle,
    structureSha256: await canonicalSha256(structureProjection),
    preimageSha256: await canonicalSha256(preimageProjection),
  };
}

function mutateScheduleTable(
  document: RhwpDocument,
  target: ScheduleTableTarget,
  phases: readonly SchedulePhase[],
): void {
  const { section, parentPara, controlIndex } = target.anchor;
  let batchStarted = false;
  try {
    assertOk(document.beginBatch(), "beginBatch");
    batchStarted = true;
    for (let rowIndex = 0; rowIndex < target.rows.length; rowIndex += 1) {
      const row = target.rows[rowIndex]!;
      const phase = phases[rowIndex] ?? null;
      const title = phase?.title ?? "-";
      const beforeLength = document.getCellParagraphLength(section, parentPara, controlIndex, row.titleCellIndex, 0);
      if (beforeLength > 0) {
        assertOk(document.deleteTextInCell(
          section,
          parentPara,
          controlIndex,
          row.titleCellIndex,
          0,
          0,
          beforeLength,
        ), "deleteTextInCell");
      }
      assertOk(document.insertTextInCell(
        section,
        parentPara,
        controlIndex,
        row.titleCellIndex,
        0,
        0,
        title,
      ), "insertTextInCell");
      if (row.titleCharProperties) {
        assertOk(document.applyCharFormatInCell(
          section,
          parentPara,
          controlIndex,
          row.titleCellIndex,
          0,
          0,
          title.length,
          JSON.stringify(row.titleCharProperties),
        ), "applyCharFormatInCell");
      }
      for (let monthIndex = 0; monthIndex < target.months.length; monthIndex += 1) {
        const month = target.months[monthIndex]!;
        const active = Boolean(phase && month >= phase.startMonth && month <= phase.endMonth);
        const currentStyle = row.monthCellStyles[monthIndex]!;
        const fillStyle = active ? target.activeFillStyle : target.inactiveFillStyle;
        assertOk(document.setCellProperties(
          section,
          parentPara,
          controlIndex,
          row.monthCellIndices[monthIndex]!,
          JSON.stringify({ ...currentStyle, ...fillStyle }),
        ), "setCellProperties");
      }
    }
  } finally {
    if (batchStarted) assertOk(document.endBatch(), "endBatch");
  }
}

function assertSchedulePostimage(
  before: ScheduleTableTarget,
  after: ScheduleTableTarget,
  phases: readonly SchedulePhase[],
): void {
  for (let rowIndex = 0; rowIndex < after.rows.length; rowIndex += 1) {
    const row = after.rows[rowIndex]!;
    const phase = phases[rowIndex] ?? null;
    const expectedTitle = phase?.title ?? "-";
    if (row.title !== expectedTitle) {
      throw new ScheduleTableVerificationError(`일정표 ${rowIndex + 1}행 제목이 승인한 미리보기와 다릅니다.`);
    }
    for (let monthIndex = 0; monthIndex < before.months.length; monthIndex += 1) {
      const month = before.months[monthIndex]!;
      const active = Boolean(phase && month >= phase.startMonth && month <= phase.endMonth);
      const expected = active ? before.activeFillColor : before.inactiveFillColor;
      if (row.monthFillColors[monthIndex] !== expected) {
        throw new ScheduleTableVerificationError(`일정표 ${rowIndex + 1}행 ${month}월 배경색이 승인한 미리보기와 다릅니다.`);
      }
      const beforeStyle = before.rows[rowIndex]!.monthCellStyles[monthIndex]!;
      const afterStyle = row.monthCellStyles[monthIndex]!;
      const expectedFillStyle = active ? before.activeFillStyle : before.inactiveFillStyle;
      if (JSON.stringify(onlyFill(afterStyle)) !== JSON.stringify(expectedFillStyle)) {
        throw new ScheduleTableVerificationError(`일정표 ${rowIndex + 1}행 ${month}월의 채우기 서식이 승인한 형식과 다릅니다.`);
      }
      if (JSON.stringify(withoutFill(afterStyle)) !== JSON.stringify(withoutFill(beforeStyle))) {
        throw new ScheduleTableVerificationError(`일정표 ${rowIndex + 1}행 ${month}월의 테두리 서식이 바뀌었습니다.`);
      }
    }
  }
}

function validatePlanForTarget(planInput: ScheduleTablePlan, target: ScheduleTableTarget): ScheduleTablePlan {
  const plan = scheduleTablePlanSchema.parse(planInput);
  if (plan.phases.length > target.rows.length) {
    throw new ScheduleTableVerificationError(`이 표에는 최대 ${target.rows.length}개 단계만 넣을 수 있습니다.`);
  }
  const monthPositions = new Map(target.months.map((month, index) => [month, index]));
  const titles = new Set<string>();
  let previousStart = -1;
  for (const phase of plan.phases) {
    const start = monthPositions.get(phase.startMonth);
    const end = monthPositions.get(phase.endMonth);
    if (start === undefined || end === undefined || start > end || start < previousStart) {
      throw new ScheduleTableVerificationError(`'${phase.title}'의 시작·종료 월이 현재 표 범위와 맞지 않습니다.`);
    }
    previousStart = start;
    const key = normalizeCellText(phase.title);
    if (titles.has(key)) throw new ScheduleTableVerificationError("같은 일정 단계 제목을 두 번 넣을 수 없습니다.");
    titles.add(key);
  }
  return plan;
}

function readSingleParagraph(
  document: RhwpDocument,
  section: number,
  parentPara: number,
  controlIndex: number,
  cellIndex: number,
): { text: string; charProperties: RhwpCellCharProperties | null } {
  const count = document.getCellParagraphCount(section, parentPara, controlIndex, cellIndex);
  if (count !== 1) throw new Error("일정표 셀 안에 여러 문단이 있어 안전한 자동 입력을 지원하지 않습니다.");
  const length = document.getCellParagraphLength(section, parentPara, controlIndex, cellIndex, 0);
  const text = unwrapTextResult(document.getTextInCell(
    section,
    parentPara,
    controlIndex,
    cellIndex,
    0,
    0,
    length,
  ));
  const charProperties = length > 0
    ? parseRhwpCellCharProperties(document.getCellCharPropertiesAt(section, parentPara, controlIndex, cellIndex, 0, 0))
    : null;
  return { text, charProperties };
}

function readBorderFillStyle(
  document: RhwpDocument,
  section: number,
  parentPara: number,
  controlIndex: number,
  cellIndex: number,
): Record<string, unknown> {
  const properties = parseJsonObject<Record<string, unknown>>(
    document.getCellOwnProperties(section, parentPara, controlIndex, cellIndex),
  );
  if (!properties) throw new Error("일정표 셀의 고유 테두리·배경 서식을 읽지 못했습니다.");
  const style: Record<string, unknown> = {};
  for (const key of BORDER_FILL_KEYS) {
    if (properties[key] !== undefined) style[key] = properties[key];
  }
  const fillColor = readStyleFillColor(style);
  if (!FILL_COLOR_PATTERN.test(fillColor)) {
    throw new Error("일정표 셀의 고유 배경색을 정확히 읽지 못했습니다.");
  }
  style.fillColor = fillColor;
  return style;
}

function readStyleFillColor(style: Record<string, unknown>): string {
  return typeof style.fillColor === "string" ? style.fillColor.toLowerCase() : "";
}

function isNeutralWhite(color: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!match) return false;
  const channels = match.slice(1).map((value) => Number.parseInt(value!, 16));
  return Math.min(...channels) >= 245 && Math.max(...channels) - Math.min(...channels) <= 6;
}

function uniqueFillStyle(rows: readonly ScheduleTableRowBinding[], color: string): Record<string, unknown> {
  const styles = rows.flatMap((row) => row.monthCellStyles)
    .filter((style) => readStyleFillColor(style) === color)
    .map(onlyFill);
  const unique = new Map(styles.map((style) => [JSON.stringify(style), style]));
  if (unique.size !== 1) {
    throw new Error("같은 배경색을 쓰는 일정표 셀의 채우기 서식이 서로 달라 자동 입력을 지원하지 않습니다.");
  }
  return unique.values().next().value ?? {};
}

function onlyFill(style: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of FILL_KEYS) {
    if (style[key] !== undefined) result[key] = style[key];
  }
  return result;
}

function withoutFill(style: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of BORDER_FILL_KEYS) {
    if (!FILL_KEYS.includes(key as (typeof FILL_KEYS)[number]) && style[key] !== undefined) result[key] = style[key];
  }
  return result;
}

function tableGeometry(
  document: RhwpDocument,
  section: number,
  parentPara: number,
  controlIndex: number,
): Array<{ cellIndex: number; row: number; col: number; pageIndex: number; x: number; w: number }> {
  const cells = parseJsonArray<{
    cellIdx?: unknown;
    row?: unknown;
    col?: unknown;
    pageIndex?: unknown;
    x?: unknown;
    y?: unknown;
    w?: unknown;
    h?: unknown;
  }>(
    document.getTableCellBboxes(section, parentPara, controlIndex, null),
  );
  return cells.flatMap((cell) => {
    const values = [cell.cellIdx, cell.row, cell.col, cell.pageIndex, cell.x, cell.y, cell.w, cell.h];
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return [];
    return [{
      cellIndex: cell.cellIdx as number,
      row: cell.row as number,
      col: cell.col as number,
      pageIndex: cell.pageIndex as number,
      x: rounded(cell.x as number),
      w: rounded(cell.w as number),
    }];
  }).sort((left, right) => left.cellIndex - right.cellIndex || left.pageIndex - right.pageIndex);
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function normalizeCellText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

function unwrapTextResult(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
      return (parsed as { text: string }).text;
    }
  } catch {
    // 일부 RHWP 버전은 평문을 직접 반환한다.
  }
  return value;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends object>(value: string): T | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function validDimensions(value: TableDimensions | null): value is TableDimensions {
  return Boolean(
    value
    && Number.isInteger(value.rowCount) && value.rowCount > 1
    && Number.isInteger(value.colCount) && value.colCount > 3
    && Number.isInteger(value.cellCount) && value.cellCount > 0,
  );
}

function assertOk(value: string, operation: string): void {
  const parsed = parseJsonObject<{ ok?: unknown }>(value);
  if (parsed?.ok !== true) throw new Error(`RHWP ${operation}이 성공하지 못했습니다.`);
}
