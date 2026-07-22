import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";

export interface RhwpEditField {
  fieldId?: string;
  label: string;
  value: string;
}

export interface RhwpEditResult {
  filled: Array<{ label: string; value: string }>;
  skipped: Array<{ label: string; value: string; reason: string }>;
}

interface SearchHit {
  sec: number;
  length: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
  };
}

interface CellInfo {
  row: number;
}

export interface RhwpEditableDocument {
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

export function buildRhwpEditFields(input: {
  answers: DraftFieldAnswers;
  duplicateLabels?: ReadonlySet<string>;
}): { fields: RhwpEditField[]; skipped: RhwpEditResult["skipped"] } {
  const fields: RhwpEditField[] = [];
  const skipped: RhwpEditResult["skipped"] = [];
  for (const [rawLabel, answer] of Object.entries(input.answers)) {
    const label = rawLabel.trim().slice(0, 160);
    const value = answer?.value?.trim().slice(0, 4_000) ?? "";
    if (!label || !value || (answer.status !== "accepted" && answer.status !== "edited")) continue;
    if (input.duplicateLabels?.has(rawLabel)) {
      skipped.push({ label, value, reason: "동일한 항목명이 여러 곳에 있어 자동 입력하지 않았습니다." });
      continue;
    }
    fields.push({
      label,
      value,
      ...(answer.fieldId ? { fieldId: answer.fieldId } : {}),
    });
  }
  return { fields, skipped };
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
): RhwpEditResult {
  const filled: RhwpEditResult["filled"] = [];
  const skipped: RhwpEditResult["skipped"] = [];
  const namedFields = parseNamedFields(document);

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
