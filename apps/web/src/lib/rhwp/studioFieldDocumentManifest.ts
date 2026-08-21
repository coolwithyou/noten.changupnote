import type { RhwpDocument } from "./client";
import {
  buildDocumentAgentSemanticManifest,
  type DocumentAgentSemanticManifest,
} from "./documentAgentManifest";
import { canonicalSha256, sha256Hex } from "./documentAgentContract";

interface PageTableControl {
  type: string;
  secIdx: number;
  paraIdx: number;
  controlIdx: number;
}

interface PageControlLayout {
  controls?: PageTableControl[];
}

interface TableDimensions {
  rowCount: number;
  colCount: number;
  cellCount: number;
}

export interface StudioFieldDocumentSemanticManifest {
  schemaVersion: "studio-field-document-semantic-manifest-v1";
  body: DocumentAgentSemanticManifest;
  formFieldsSha256: string;
  tables: Array<{
    section: number;
    parentPara: number;
    controlIndex: number;
    dimensions: TableDimensions;
    cells: Array<{
      cellIndex: number;
      propertiesSha256: string;
      paragraphs: Array<{
        cellParagraph: number;
        length: number;
        textSha256: string;
        paraPropertiesSha256: string;
        charPropertiesSha256: string;
      }>;
    }>;
  }>;
}

/**
 * HWP/HWPX 컨테이너의 재직렬화 바이트는 달라도, 본문·누름틀·모든 표 셀의
 * 텍스트와 서식이 같으면 같은 Studio 필드 명령 preimage로 판정한다.
 */
export async function buildStudioFieldDocumentSemanticManifest(
  document: RhwpDocument,
): Promise<StudioFieldDocumentSemanticManifest> {
  const body = await buildDocumentAgentSemanticManifest(document);
  const formFields = parseJson(document.getFieldList(), "누름틀 목록");
  const tableTargets = new Map<string, Omit<PageTableControl, "type">>();
  for (let page = 0; page < document.pageCount(); page += 1) {
    const layout = parseJson(document.getPageControlLayout(page), "페이지 control layout") as PageControlLayout;
    if (layout.controls !== undefined && !Array.isArray(layout.controls)) {
      throw new Error("RHWP 페이지 control 목록이 배열이 아닙니다.");
    }
    for (const control of layout.controls ?? []) {
      if (control.type !== "table") continue;
      assertNonnegativeInteger(control.secIdx, "table section");
      assertNonnegativeInteger(control.paraIdx, "table parent paragraph");
      assertNonnegativeInteger(control.controlIdx, "table control index");
      const key = `${control.secIdx}:${control.paraIdx}:${control.controlIdx}`;
      tableTargets.set(key, {
        secIdx: control.secIdx,
        paraIdx: control.paraIdx,
        controlIdx: control.controlIdx,
      });
    }
  }

  const tables: StudioFieldDocumentSemanticManifest["tables"] = [];
  for (const target of [...tableTargets.values()].sort(compareTableTargets)) {
    const dimensions = parseTableDimensions(document.getTableDimensions(
      target.secIdx,
      target.paraIdx,
      target.controlIdx,
    ));
    const cells: StudioFieldDocumentSemanticManifest["tables"][number]["cells"] = [];
    for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
      const paragraphCount = document.getCellParagraphCount(
        target.secIdx,
        target.paraIdx,
        target.controlIdx,
        cellIndex,
      );
      assertNonnegativeInteger(paragraphCount, "table cell paragraph count");
      const paragraphs: StudioFieldDocumentSemanticManifest["tables"][number]["cells"][number]["paragraphs"] = [];
      for (let cellParagraph = 0; cellParagraph < paragraphCount; cellParagraph += 1) {
        const length = document.getCellParagraphLength(
          target.secIdx,
          target.paraIdx,
          target.controlIdx,
          cellIndex,
          cellParagraph,
        );
        assertNonnegativeInteger(length, "table cell paragraph length");
        const text = length > 0 ? document.getTextInCell(
          target.secIdx,
          target.paraIdx,
          target.controlIdx,
          cellIndex,
          cellParagraph,
          0,
          length,
        ) : "";
        const charProperties: unknown[] = [];
        for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
          charProperties.push(parseJson(document.getCellCharPropertiesAt(
            target.secIdx,
            target.paraIdx,
            target.controlIdx,
            cellIndex,
            cellParagraph,
            offset,
          ), "table cell character properties"));
        }
        paragraphs.push({
          cellParagraph,
          length,
          textSha256: await sha256Hex(text),
          paraPropertiesSha256: await canonicalSha256(parseJson(document.getCellParaPropertiesAt(
            target.secIdx,
            target.paraIdx,
            target.controlIdx,
            cellIndex,
            cellParagraph,
          ), "table cell paragraph properties")),
          charPropertiesSha256: await canonicalSha256(charProperties),
        });
      }
      cells.push({
        cellIndex,
        propertiesSha256: await canonicalSha256(parseJson(document.getCellOwnProperties(
          target.secIdx,
          target.paraIdx,
          target.controlIdx,
          cellIndex,
        ), "table cell properties")),
        paragraphs,
      });
    }
    tables.push({
      section: target.secIdx,
      parentPara: target.paraIdx,
      controlIndex: target.controlIdx,
      dimensions,
      cells,
    });
  }

  return {
    schemaVersion: "studio-field-document-semantic-manifest-v1",
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

function compareTableTargets(
  left: Omit<PageTableControl, "type">,
  right: Omit<PageTableControl, "type">,
): number {
  return left.secIdx - right.secIdx
    || left.paraIdx - right.paraIdx
    || left.controlIdx - right.controlIdx;
}
