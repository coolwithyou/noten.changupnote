import {
  resolveRhwpFieldAnchorsExact,
  type RhwpAnchorDocument,
  type RhwpFieldDescriptor,
} from "./fieldAnchors";
import type { StudioFieldTargetV1, StudioFormTextTargetV1 } from "./studioDocumentAgentProtocol";

interface FormFieldEntry {
  fieldId: number;
  fieldType: string;
  cellField: boolean;
  name: string;
  location: { sectionIndex: number; paraIndex: number; path?: unknown[] };
  startCharIdx?: number;
  endCharIdx?: number;
  editableInForm?: boolean;
}

export interface StudioFieldBindingDocument extends RhwpAnchorDocument {
  getFieldList(): string;
}

export type StudioFieldBindingResolution =
  | { fieldId: string; status: "unique"; target: StudioFieldTargetV1; candidateCount: 1 }
  | { fieldId: string; status: "missing"; candidateCount: 0 }
  | { fieldId: string; status: "ambiguous"; candidateCount: number };

/**
 * 기존 exact 표 셀 binding을 우선 보존하고, 표 셀이 없을 때만 본문 누름틀 이름을
 * fieldKey/label과 NFKC+trim exact 비교한다. 중첩 필드와 동명이인은 임의 선택하지 않는다.
 */
export function resolveStudioFieldBindings(
  document: StudioFieldBindingDocument,
  fields: readonly RhwpFieldDescriptor[],
): StudioFieldBindingResolution[] {
  const tableResolutions = resolveRhwpFieldAnchorsExact(document, fields);
  let formFields: FormFieldEntry[] | null = null;
  const loadFormFields = () => {
    if (formFields) return formFields;
    try {
      const parsed = JSON.parse(document.getFieldList()) as unknown;
      formFields = Array.isArray(parsed) ? parsed as FormFieldEntry[] : [];
    } catch {
      formFields = [];
    }
    return formFields;
  };

  return tableResolutions.map((table, index) => {
    if (table.status === "unique") {
      const target = table.anchor.target;
      return {
        fieldId: table.fieldId,
        status: "unique",
        target: {
          kind: "table_cell_text",
          section: target.section,
          parentPara: target.parentPara,
          controlIndex: target.controlIndex,
          cellIndex: target.cellIndex,
          cellParagraph: target.cellParagraph,
        },
        candidateCount: 1,
      };
    }
    if (table.status === "ambiguous") return table;

    const field = fields[index]!;
    const names = new Set([field.fieldKey, field.label]
      .filter((value): value is string => typeof value === "string" && normalizeName(value).length > 0)
      .map(normalizeName));
    const candidates = loadFormFields()
      .filter(isSupportedRootFormField)
      .filter(entry => names.has(normalizeName(entry.name)))
      .map((entry): StudioFormTextTargetV1 => ({
        kind: "form_text",
        section: entry.location.sectionIndex,
        paragraph: entry.location.paraIndex,
        fieldId: entry.fieldId,
      }));
    const uniqueTargets = new Map(candidates.map(target => [targetKey(target), target]));
    if (uniqueTargets.size === 0) return table;
    if (uniqueTargets.size > 1) {
      return { fieldId: field.fieldId, status: "ambiguous", candidateCount: uniqueTargets.size };
    }
    return {
      fieldId: field.fieldId,
      status: "unique",
      target: [...uniqueTargets.values()][0]!,
      candidateCount: 1,
    };
  });
}

function isSupportedRootFormField(entry: FormFieldEntry): boolean {
  const path = entry.location?.path;
  return Number.isSafeInteger(entry.fieldId)
    && entry.fieldId >= 0
    && entry.fieldType === "clickhere"
    && entry.cellField === false
    && entry.editableInForm === true
    && Number.isSafeInteger(entry.location?.sectionIndex)
    && entry.location.sectionIndex >= 0
    && Number.isSafeInteger(entry.location?.paraIndex)
    && entry.location.paraIndex >= 0
    && (!Array.isArray(path) || path.length === 0)
    && Number.isSafeInteger(entry.startCharIdx)
    && Number.isSafeInteger(entry.endCharIdx)
    && (entry.startCharIdx as number) >= 0
    && (entry.endCharIdx as number) >= (entry.startCharIdx as number);
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim();
}

function targetKey(target: StudioFormTextTargetV1): string {
  return `${target.section}:${target.paragraph}:${target.fieldId}`;
}
