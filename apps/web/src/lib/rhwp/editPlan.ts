import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { extractFieldOptions } from "@/lib/documents/fieldOptions";
import {
  resolveRhwpFieldAnchors,
  type RhwpAnchorDocument,
  type RhwpFieldAnchor,
} from "./fieldAnchors";

export interface RhwpEditField {
  fieldId?: string;
  fieldKey?: string;
  label: string;
  value: string;
  fieldType?: string;
  sourceSpan?: string | null;
  position?: Record<string, unknown> | null;
  options?: string[];
}

export interface RhwpEditResult {
  filled: Array<{ label: string; value: string }>;
  skipped: Array<{ label: string; value: string; reason: string }>;
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

interface CellInfo {
  row: number;
}

export interface RhwpEditableDocument {
  pageCount?: () => number;
  getPageInfo?: (page: number) => string;
  getTableCellBboxes?: (
    section: number,
    parentPara: number,
    controlIndex: number,
    pageHint?: number | null,
  ) => string;
  getSelectionRectsInCell?: RhwpAnchorDocument["getSelectionRectsInCell"];
  getFieldList?: () => string;
  setFieldValueByName?: (name: string, value: string) => string;
  searchAllText(query: string, caseSensitive: boolean, includeCells: boolean): string;
  getCellInfo(section: number, parentPara: number, controlIndex: number, cellIndex: number): string;
  getCellParagraphLength(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
  ): number;
  getCellCharPropertiesAt?: (
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
  ) => string;
  applyCharFormatInCell?: (
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    startOffset: number,
    endOffset: number,
    properties: string,
  ) => string;
  getTextInCell?: (
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
    count: number,
  ) => string;
  deleteTextInCell?: (
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
    count: number,
  ) => string;
  insertTextInCell(
    section: number,
    parentPara: number,
    controlIndex: number,
    cellIndex: number,
    cellParagraph: number,
    charOffset: number,
    text: string,
  ): string;
}

interface NamedFieldInfo {
  name: string;
  value?: string;
  guide?: string;
}

interface CellCharProperties {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textColor?: string;
}

export function buildRhwpEditFields(input: {
  answers: DraftFieldAnswers;
  connectedFields?: readonly ConnectedDocumentField[];
  duplicateLabels?: ReadonlySet<string>;
}): { fields: RhwpEditField[]; skipped: RhwpEditResult["skipped"] } {
  const fields: RhwpEditField[] = [];
  const skipped: RhwpEditResult["skipped"] = [];
  const entries: Array<[string, DraftFieldAnswers[string] | undefined, ConnectedDocumentField | undefined]> = input.connectedFields
    ? input.connectedFields.map((field) => [field.label, input.answers[field.label.trim().slice(0, 160)], field])
    : Object.entries(input.answers).map(([label, answer]) => [label, answer, undefined]);
  for (const [rawLabel, answer, connectedField] of entries) {
    const label = rawLabel.trim().slice(0, 160);
    const value = answer?.value?.trim().slice(0, 4_000) ?? "";
    if (!answer || !label || !value || (answer.status !== "accepted" && answer.status !== "edited")) continue;
    if (input.duplicateLabels?.has(rawLabel)) {
      skipped.push({ label, value, reason: "동일한 항목명이 여러 곳에 있어 자동 입력하지 않았습니다." });
      continue;
    }
    fields.push({
      label,
      value,
      ...(connectedField?.fieldId || answer.fieldId ? { fieldId: connectedField?.fieldId ?? answer.fieldId } : {}),
      ...(connectedField ? {
        fieldKey: connectedField.fieldKey,
        fieldType: connectedField.fieldType,
        sourceSpan: connectedField.sourceSpan,
        position: connectedField.position,
        options: extractFieldOptions(connectedField.fieldType, connectedField.sourceSpan),
      } : {}),
    });
  }
  return { fields, skipped };
}

function canResolveStructuralAnchors(document: RhwpEditableDocument): document is RhwpEditableDocument & RhwpAnchorDocument {
  return Boolean(document.pageCount && document.getPageInfo && document.getTableCellBboxes);
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

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

function isUnitOnly(value: string): boolean {
  return /^\s*[([]?\s*(?:천원|백만원|억원|만원|원|명|개|건|년|개월|일|%|㎡|m²|km²)\s*[)\]]?\s*$/iu.test(value);
}

const GUIDE_TEXT_PATTERN = /(?:기재\s*(?:시|란|요령|바랍니다|하세요)?|작성\s*(?:예시|요령|내용|란)?|입력\s*(?:예시|란|하세요)?|서술\s*(?:예시|하세요)?|제시|선택\s*기입|해당\s*시|예시|sample)|^[※*]/iu;
const STRONG_GUIDE_PATTERN = /(?:기재\s*시|선택\s*기입|작성\s*예시|입력\s*예시|^[※*])/iu;

function parseCellCharProperties(value: string | null | undefined): CellCharProperties | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as CellCharProperties : null;
  } catch {
    return null;
  }
}

function isGuideStyle(properties: CellCharProperties | null): boolean {
  if (!properties) return false;
  const color = properties.textColor?.toLocaleLowerCase("en-US");
  return properties.italic === true || Boolean(color && color !== "#000000" && color !== "#111111");
}

function isReplaceableGuide(
  value: string,
  sourceSpan: string | null | undefined,
  properties: CellCharProperties | null,
): boolean {
  const normalized = normalizedText(value);
  if (!normalized || !GUIDE_TEXT_PATTERN.test(value)) return false;
  const sourceConfirmed = Boolean(sourceSpan && normalizedText(sourceSpan).includes(normalized));
  return sourceConfirmed || isGuideStyle(properties) || STRONG_GUIDE_PATTERN.test(value);
}

function readCellCharProperties(
  document: RhwpEditableDocument,
  anchor: RhwpFieldAnchor,
  cellIndex: number,
  charOffset: number,
): CellCharProperties | null {
  if (!document.getCellCharPropertiesAt) return null;
  try {
    return parseCellCharProperties(document.getCellCharPropertiesAt(
      anchor.target.section,
      anchor.target.parentPara,
      anchor.target.controlIndex,
      cellIndex,
      anchor.target.cellParagraph,
      Math.max(0, charOffset),
    ));
  } catch {
    return null;
  }
}

function estimatedTextUnits(value: string): number {
  return [...value].reduce((sum, character) => {
    if (/\s/u.test(character)) return sum + 0.35;
    if (/[\x00-\x7F]/u.test(character)) return sum + 0.62;
    return sum + 1;
  }, 0);
}

function insertedTextFormat(
  document: RhwpEditableDocument,
  field: RhwpEditField,
  anchor: RhwpFieldAnchor,
  currentProperties: CellCharProperties | null,
): CellCharProperties {
  const labelProperties = typeof anchor.target.labelCellIndex === "number"
    ? readCellCharProperties(document, anchor, anchor.target.labelCellIndex, 0)
    : null;
  let cellWidth = 0;
  let cellHeight = 0;
  if (document.getPageInfo) {
    try {
      const page = JSON.parse(document.getPageInfo(anchor.page - 1)) as { width?: unknown; height?: unknown };
      if (typeof page.width === "number" && typeof page.height === "number") {
        cellWidth = anchor.box.width * page.width;
        cellHeight = anchor.box.height * page.height;
      }
    } catch {
      // 좌표가 없으면 원본 문자 속성만 사용한다.
    }
  }
  const originalFontSize = Math.max(
    typeof currentProperties?.fontSize === "number" ? currentProperties.fontSize : 0,
    typeof labelProperties?.fontSize === "number" ? labelProperties.fontSize : 0,
  );
  const proportionalFontSize = cellHeight > 0 && cellHeight <= 36
    ? Math.round(Math.min(1_200, Math.max(800, cellHeight * 40)) / 50) * 50
    : 0;
  let fontSize = Math.max(originalFontSize, proportionalFontSize, 900);
  if (cellWidth > 12 && cellHeight > 0 && cellHeight <= 36) {
    const units = estimatedTextUnits(field.value);
    if (units > 0) {
      const fitFontSize = Math.floor(((cellWidth - 8) * 75 / units) / 50) * 50;
      fontSize = Math.min(fontSize, Math.max(700, fitFontSize));
    }
  }
  const fontFamily = currentProperties?.fontFamily ?? labelProperties?.fontFamily;
  return {
    ...(fontFamily ? { fontFamily } : {}),
    fontSize,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    textColor: labelProperties?.textColor ?? "#000000",
  };
}

function insertAndFormatCellText(
  document: RhwpEditableDocument,
  field: RhwpEditField,
  anchor: RhwpFieldAnchor,
  offset: number,
  currentProperties: CellCharProperties | null,
): string | null {
  const target = anchor.target;
  if (!parsedOk(document.insertTextInCell(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
    target.cellParagraph,
    offset,
    field.value,
  ))) return "rhwp가 대상 셀 입력을 완료하지 못했습니다.";
  if (!document.applyCharFormatInCell) return null;
  return parsedOk(document.applyCharFormatInCell(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
    target.cellParagraph,
    offset,
    offset + field.value.length,
    JSON.stringify(insertedTextFormat(document, field, anchor, currentProperties)),
  )) ? null : "입력값의 글자 서식을 문서에 맞추지 못했습니다.";
}

function applyCellText(
  document: RhwpEditableDocument,
  field: RhwpEditField,
  anchor: RhwpFieldAnchor,
): string | null {
  const target = anchor.target;
  const length = document.getCellParagraphLength(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
    target.cellParagraph,
  );
  const currentRaw = length > 0 && document.getTextInCell
    ? textFromCellResult(document.getTextInCell(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.cellIndex,
        target.cellParagraph,
        0,
        length,
      ))
    : "";
  const firstVisibleOffset = Math.max(0, currentRaw.search(/\S/u));
  const currentProperties = readCellCharProperties(document, anchor, target.cellIndex, firstVisibleOffset);
  if (length <= 0) {
    return insertAndFormatCellText(document, field, anchor, 0, currentProperties);
  }
  if (!document.getTextInCell) return "입력 셀에 기존 내용이 있어 덮어쓰지 않았습니다.";
  const current = currentRaw.trim();
  if (!current) {
    if (document.deleteTextInCell && !parsedOk(document.deleteTextInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
      0,
      length,
    ))) return "입력 셀의 공백을 정리하지 못했습니다.";
    return insertAndFormatCellText(document, field, anchor, 0, currentProperties);
  }
  if (isUnitOnly(current)) {
    return insertAndFormatCellText(document, field, anchor, 0, currentProperties);
  }
  if (!isReplaceableGuide(current, field.sourceSpan, currentProperties)) {
    return "입력 셀에 기존 내용이 있어 덮어쓰지 않았습니다.";
  }
  if (!document.deleteTextInCell) return "서식 안내문을 안전하게 교체할 수 없습니다.";
  if (!parsedOk(document.deleteTextInCell(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
    target.cellParagraph,
    0,
    length,
  ))) return "서식 안내문을 지우지 못했습니다.";
  return insertAndFormatCellText(document, field, anchor, 0, currentProperties);
}

function applyCheckboxChoice(
  document: RhwpEditableDocument,
  field: RhwpEditField,
  anchor: RhwpFieldAnchor,
): string | null {
  const selected = field.options?.find((option) => normalizedText(option) === normalizedText(field.value));
  if (!selected) return "원본 양식의 선택지와 일치하는 값을 찾지 못했습니다.";
  if (!document.getTextInCell || !document.deleteTextInCell) {
    return "체크박스 문자를 안전하게 편집할 수 없습니다.";
  }
  const edits: Array<{ paragraph: number; offset: number; glyph: "□" | "■" }> = [];
  for (const option of field.options ?? []) {
    const hits = parseJsonArray(document.searchAllText(option, false, true)).filter((hit) => {
      const context = hit.cellContext;
      return context
        && hit.sec === anchor.target.section
        && context.parentPara === anchor.target.parentPara
        && context.ctrlIdx === anchor.target.controlIndex
        && context.cellIdx === anchor.target.cellIndex;
    });
    if (hits.length !== 1) return `선택지 '${option}'의 위치가 모호합니다.`;
    const hit = hits[0]!;
    const paragraph = hit.cellContext?.cellPara ?? 0;
    const optionOffset = hit.charOffset ?? 0;
    const paragraphLength = document.getCellParagraphLength(
      anchor.target.section,
      anchor.target.parentPara,
      anchor.target.controlIndex,
      anchor.target.cellIndex,
      paragraph,
    );
    const text = textFromCellResult(document.getTextInCell(
      anchor.target.section,
      anchor.target.parentPara,
      anchor.target.controlIndex,
      anchor.target.cellIndex,
      paragraph,
      0,
      paragraphLength,
    ));
    const prefix = text.slice(0, optionOffset);
    const offset = Math.max(prefix.lastIndexOf("□"), prefix.lastIndexOf("☐"), prefix.lastIndexOf("☑"), prefix.lastIndexOf("■"));
    if (offset < 0) return `선택지 '${option}' 앞의 체크박스를 찾지 못했습니다.`;
    edits.push({ paragraph, offset, glyph: option === selected ? "■" : "□" });
  }
  edits.sort((a, b) => b.paragraph - a.paragraph || b.offset - a.offset);
  for (const edit of edits) {
    if (!parsedOk(document.deleteTextInCell(
      anchor.target.section,
      anchor.target.parentPara,
      anchor.target.controlIndex,
      anchor.target.cellIndex,
      edit.paragraph,
      edit.offset,
      1,
    )) || !parsedOk(document.insertTextInCell(
      anchor.target.section,
      anchor.target.parentPara,
      anchor.target.controlIndex,
      anchor.target.cellIndex,
      edit.paragraph,
      edit.offset,
      edit.glyph,
    ))) return "체크박스 선택을 문서에 반영하지 못했습니다.";
  }
  return null;
}

function parseJsonArray(value: string): SearchHit[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is SearchHit => {
    if (!item || typeof item !== "object") return false;
    const hit = item as Partial<SearchHit>;
    return typeof hit.sec === "number" && typeof hit.length === "number";
  });
}

function parseCellInfo(value: string): CellInfo | null {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { row?: unknown }).row !== "number") {
    return null;
  }
  return parsed as CellInfo;
}

function parsedOk(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

function parseNamedFields(document: RhwpEditableDocument): NamedFieldInfo[] {
  if (!document.getFieldList) return [];
  try {
    const parsed = JSON.parse(document.getFieldList()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NamedFieldInfo => Boolean(
      item
      && typeof item === "object"
      && typeof (item as { name?: unknown }).name === "string",
    ));
  } catch {
    return [];
  }
}

/**
 * 보수적 1차 EditPlan 실행기: 정확한 라벨이 있는 표 셀의 같은 행 오른쪽 빈 셀만 채운다.
 * 모호함·기존 값·중첩/다중 매치는 전부 건너뛴다.
 */
export function applyRhwpEditFields(
  document: RhwpEditableDocument,
  fields: readonly RhwpEditField[],
  manualAnchors: readonly RhwpFieldAnchor[] = [],
): RhwpEditResult {
  const filled: RhwpEditResult["filled"] = [];
  const skipped: RhwpEditResult["skipped"] = [];
  const namedFields = parseNamedFields(document);
  const structuralAnchors = canResolveStructuralAnchors(document)
    ? resolveRhwpFieldAnchors(document, fields.map((field) => ({
        fieldId: field.fieldId ?? field.label,
        label: field.label,
        fieldType: field.fieldType ?? "text",
        ...(field.fieldKey !== undefined ? { fieldKey: field.fieldKey } : {}),
        ...(field.sourceSpan !== undefined ? { sourceSpan: field.sourceSpan } : {}),
        ...(field.position !== undefined ? { position: field.position } : {}),
        ...(field.options !== undefined ? { options: field.options } : {}),
      })))
    : [];
  const anchorsById = new Map(structuralAnchors.map((anchor) => [anchor.fieldId, anchor]));
  for (const anchor of manualAnchors) anchorsById.set(anchor.fieldId, anchor);

  for (const field of fields) {
    try {
      const namedMatches = namedFields.filter((candidate) => candidate.name.trim() === field.label);
      if (namedMatches.length > 1) {
        skipped.push({ label: field.label, value: field.value, reason: "이름이 같은 누름틀이 여러 곳에 있어 자동 입력하지 않았습니다." });
        continue;
      }
      if (namedMatches.length === 1 && document.setFieldValueByName) {
        const named = namedMatches[0]!;
        const currentValue = named.value?.trim() ?? "";
        const guide = named.guide?.trim() ?? "";
        if (currentValue && currentValue !== guide) {
          skipped.push({ label: field.label, value: field.value, reason: "누름틀에 기존 내용이 있어 덮어쓰지 않았습니다." });
          continue;
        }
        if (parsedOk(document.setFieldValueByName(named.name, field.value))) {
          filled.push({ label: field.label, value: field.value });
          continue;
        }
        skipped.push({ label: field.label, value: field.value, reason: "rhwp가 누름틀 입력을 완료하지 못했습니다." });
        continue;
      }
      const structuralAnchor = anchorsById.get(field.fieldId ?? field.label);
      if (structuralAnchor) {
        const reason = field.options?.length
          ? applyCheckboxChoice(document, field, structuralAnchor)
          : applyCellText(document, field, structuralAnchor);
        if (reason) skipped.push({ label: field.label, value: field.value, reason });
        else filled.push({ label: field.label, value: field.value });
        continue;
      }
      const hits = parseJsonArray(document.searchAllText(field.label, false, true))
        .filter((hit) => hit.length === field.label.length && hit.cellContext);
      const candidates: Array<{
        section: number;
        parentPara: number;
        controlIndex: number;
        targetCell: number;
      }> = [];
      for (const hit of hits) {
        const context = hit.cellContext!;
        const targetCell = context.cellIdx + 1;
        const labelInfo = parseCellInfo(
          document.getCellInfo(hit.sec, context.parentPara, context.ctrlIdx, context.cellIdx),
        );
        const targetInfo = parseCellInfo(
          document.getCellInfo(hit.sec, context.parentPara, context.ctrlIdx, targetCell),
        );
        if (!labelInfo || !targetInfo || labelInfo.row !== targetInfo.row) continue;
        if (document.getCellParagraphLength(hit.sec, context.parentPara, context.ctrlIdx, targetCell, 0) > 0) {
          continue;
        }
        candidates.push({
          section: hit.sec,
          parentPara: context.parentPara,
          controlIndex: context.ctrlIdx,
          targetCell,
        });
      }
      if (candidates.length === 0) {
        skipped.push({ label: field.label, value: field.value, reason: "라벨 오른쪽의 빈 입력 셀을 찾지 못했습니다." });
        continue;
      }
      if (candidates.length > 1) {
        skipped.push({ label: field.label, value: field.value, reason: "입력 가능한 위치가 여러 곳이라 자동 입력하지 않았습니다." });
        continue;
      }
      const target = candidates[0]!;
      const result = document.insertTextInCell(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.targetCell,
        0,
        0,
        field.value,
      );
      if (!parsedOk(result)) {
        skipped.push({ label: field.label, value: field.value, reason: "rhwp가 대상 셀 입력을 완료하지 못했습니다." });
        continue;
      }
      filled.push({ label: field.label, value: field.value });
    } catch {
      skipped.push({ label: field.label, value: field.value, reason: "문서 위치를 검증하는 중 오류가 발생했습니다." });
    }
  }
  return { filled, skipped };
}
