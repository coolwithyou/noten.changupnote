import type { RhwpDocument } from "./client";
import {
  buildDocumentAgentSemanticManifest,
  type DocumentAgentSemanticManifest,
} from "./documentAgentManifest";
import { canonicalSha256, sha256Hex } from "./documentAgentContract";

interface CellPathEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

interface PageControl {
  type: string;
  secIdx: number;
  paraIdx: number;
  controlIdx: number;
  stableIndex?: number[];
}

interface PageControlLayout {
  controls?: PageControl[];
}

interface PageTextRun {
  parentParaIdx?: number;
  cellPath?: CellPathEntry[];
}

interface PageTextLayout {
  runs?: PageTextRun[];
}

interface TableDimensions {
  rowCount: number;
  colCount: number;
  cellCount: number;
}

interface TopLevelTableTarget {
  section: number;
  parentPara: number;
  controlIndex: number;
}

export interface StudioFieldDocumentSemanticManifest {
  schemaVersion: "studio-field-document-semantic-manifest-v2";
  body: DocumentAgentSemanticManifest;
  formFieldsSha256: string;
  tables: Array<TopLevelTableTarget & {
    dimensions: TableDimensions;
    controlHtmlSha256: string;
  }>;
}

/**
 * HWP/HWPX 컨테이너의 재직렬화 바이트는 달라도, 본문·누름틀·모든 최상위 표의
 * 재귀 HTML(중첩 표의 텍스트·문단/문자 서식·셀 테두리 포함)이 같으면 같은
 * Studio 필드 명령 preimage로 판정한다.
 *
 * getPageControlLayout은 중첩 표도 평탄화해 내보내지만, 중첩 표의 paraIdx는
 * 최상위 본문 문단이 아니라 셀 안 로컬 문단 인덱스다. 이를 flat table API에
 * 넣으면 다른 컨트롤을 읽거나 실패한다. 따라서 stableIndex 길이 3인 최상위 표만
 * exportControlHtml로 읽고, 모든 중첩 표가 그 최상위 표 아래에 실제로 결속됐는지는
 * 같은 페이지 text layout의 full cellPath로 별도 검증한다.
 */
export async function buildStudioFieldDocumentSemanticManifest(
  document: RhwpDocument,
): Promise<StudioFieldDocumentSemanticManifest> {
  const body = await buildDocumentAgentSemanticManifest(document);
  const formFields = parseJson(document.getFieldList(), "누름틀 목록");
  const topLevelTables = new Map<string, TopLevelTableTarget>();
  const nestedRoots = new Set<string>();

  for (let page = 0; page < document.pageCount(); page += 1) {
    const layout = parsePageControlLayout(document.getPageControlLayout(page));
    const textLayout = parsePageTextLayout(document.getPageTextLayout(page));
    for (const control of layout.controls ?? []) {
      if (control.type !== "table") continue;
      const stableIndex = parseStableIndex(control);
      if (stableIndex.length === 3) {
        if (
          stableIndex[0] !== control.secIdx
          || stableIndex[1] !== control.paraIdx
          || stableIndex[2] !== control.controlIdx
        ) {
          throw new Error("RHWP 최상위 표의 stableIndex와 문서 좌표가 다릅니다.");
        }
        const target = {
          section: control.secIdx,
          parentPara: control.paraIdx,
          controlIndex: control.controlIdx,
        };
        topLevelTables.set(tableTargetKey(target), target);
        continue;
      }

      const nestedPath = cellPathFromNestedStableIndex(stableIndex);
      const matchingRun = (textLayout.runs ?? []).find((run) => {
        const path = parseOptionalCellPath(run.cellPath);
        return path !== null && sameTableCellPath(path, nestedPath);
      });
      if (!matchingRun || !Number.isSafeInteger(matchingRun.parentParaIdx) || matchingRun.parentParaIdx! < 0) {
        throw new Error("RHWP 중첩 표를 최상위 표 경로에 결속하지 못했습니다.");
      }
      nestedRoots.add(tableTargetKey({
        section: control.secIdx,
        parentPara: matchingRun.parentParaIdx!,
        controlIndex: nestedPath[0]!.controlIndex,
      }));
    }
  }

  for (const rootKey of nestedRoots) {
    if (!topLevelTables.has(rootKey)) {
      throw new Error("RHWP 중첩 표의 최상위 컨테이너가 표가 아닙니다.");
    }
  }

  const tables: StudioFieldDocumentSemanticManifest["tables"] = [];
  for (const target of [...topLevelTables.values()].sort(compareTableTargets)) {
    const dimensions = parseTableDimensions(document.getTableDimensions(
      target.section,
      target.parentPara,
      target.controlIndex,
    ));
    const html = document.exportControlHtml(
      target.section,
      target.parentPara,
      "",
      target.controlIndex,
    );
    const unsupportedWarnings = [...html.matchAll(/<!-- rhwp:[^>]+내용 생략됨[^>]*-->/g)]
      .map(([warning]) => warning)
      // Field 값과 메타데이터는 위 formFieldsSha256에서 별도 전수 결속한다.
      .filter((warning) => !warning.includes("셀 안 Field 컨트롤"));
    if (unsupportedWarnings.length > 0) {
      throw new Error(`RHWP 표 HTML에서 지원하지 않는 중첩 컨트롤이 생략됐습니다: ${unsupportedWarnings[0]}`);
    }
    tables.push({
      ...target,
      dimensions,
      controlHtmlSha256: await sha256Hex(html),
    });
  }

  return {
    schemaVersion: "studio-field-document-semantic-manifest-v2",
    body,
    formFieldsSha256: await canonicalSha256(formFields),
    tables,
  };
}

export async function studioFieldDocumentSemanticSha256(document: RhwpDocument): Promise<string> {
  return canonicalSha256(await buildStudioFieldDocumentSemanticManifest(document));
}

export function matchesStudioFieldDocumentPreimage(input: {
  currentDocumentSha256: string;
  currentSemanticSha256: string;
  expectedDocumentSha256: string;
  expectedSemanticSha256: string | null;
}): boolean {
  if (input.currentDocumentSha256 === input.expectedDocumentSha256) return true;
  return input.expectedSemanticSha256 !== null
    && input.currentSemanticSha256 === input.expectedSemanticSha256;
}

function parsePageControlLayout(value: string): PageControlLayout {
  const parsed = parseJson(value, "페이지 control layout") as PageControlLayout;
  if (parsed.controls !== undefined && !Array.isArray(parsed.controls)) {
    throw new Error("RHWP 페이지 control 목록이 배열이 아닙니다.");
  }
  return parsed;
}

function parsePageTextLayout(value: string): PageTextLayout {
  const parsed = parseJson(value, "페이지 text layout") as PageTextLayout;
  if (parsed.runs !== undefined && !Array.isArray(parsed.runs)) {
    throw new Error("RHWP 페이지 text run 목록이 배열이 아닙니다.");
  }
  return parsed;
}

function parseStableIndex(control: PageControl): number[] {
  assertNonnegativeInteger(control.secIdx, "table section");
  assertNonnegativeInteger(control.paraIdx, "table paragraph");
  assertNonnegativeInteger(control.controlIdx, "table control index");
  const stableIndex = control.stableIndex;
  if (
    !Array.isArray(stableIndex)
    || stableIndex.length < 3
    || (stableIndex.length - 3) % 3 !== 0
    || stableIndex.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("RHWP 표 stableIndex 경로가 올바르지 않습니다.");
  }
  return stableIndex;
}

function cellPathFromNestedStableIndex(stableIndex: number[]): CellPathEntry[] {
  const values = stableIndex.slice(2, -1);
  if (values.length < 3 || values.length % 3 !== 0) {
    throw new Error("RHWP 중첩 표 stableIndex 경로가 올바르지 않습니다.");
  }
  const path: CellPathEntry[] = [];
  for (let offset = 0; offset < values.length; offset += 3) {
    path.push({
      controlIndex: values[offset]!,
      cellIndex: values[offset + 1]!,
      cellParaIndex: values[offset + 2]!,
    });
  }
  return path;
}

function parseOptionalCellPath(value: unknown): CellPathEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const path: CellPathEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as Partial<CellPathEntry>;
    if (
      !Number.isSafeInteger(candidate.controlIndex)
      || !Number.isSafeInteger(candidate.cellIndex)
      || !Number.isSafeInteger(candidate.cellParaIndex)
      || candidate.controlIndex! < 0
      || candidate.cellIndex! < 0
      || candidate.cellParaIndex! < 0
    ) return null;
    path.push(candidate as CellPathEntry);
  }
  return path;
}

/** 같은 표의 셀 경로면 마지막 cell/paragraph만 달라질 수 있다. */
function sameTableCellPath(left: CellPathEntry[], right: CellPathEntry[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]!.controlIndex !== right[index]!.controlIndex) return false;
    if (index === left.length - 1) continue;
    if (
      left[index]!.cellIndex !== right[index]!.cellIndex
      || left[index]!.cellParaIndex !== right[index]!.cellParaIndex
    ) return false;
  }
  return true;
}

function parseTableDimensions(value: string): TableDimensions {
  const parsed = parseJson(value, "table dimensions") as Partial<TableDimensions>;
  assertNonnegativeInteger(parsed.rowCount, "table row count");
  assertNonnegativeInteger(parsed.colCount, "table column count");
  assertNonnegativeInteger(parsed.cellCount, "table cell count");
  return {
    rowCount: parsed.rowCount,
    colCount: parsed.colCount,
    cellCount: parsed.cellCount,
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`RHWP ${label} JSON을 해석하지 못했습니다.`);
  }
}

function assertNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`RHWP ${label} 값이 올바르지 않습니다.`);
  }
}

function tableTargetKey(target: TopLevelTableTarget): string {
  return `${target.section}:${target.parentPara}:${target.controlIndex}`;
}

function compareTableTargets(left: TopLevelTableTarget, right: TopLevelTableTarget): number {
  return left.section - right.section
    || left.parentPara - right.parentPara
    || left.controlIndex - right.controlIndex;
}
