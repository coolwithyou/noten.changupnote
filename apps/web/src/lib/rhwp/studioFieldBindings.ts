import {
  resolveRhwpFieldAnchorsExact,
  type RhwpAnchorDocument,
  type RhwpFieldDescriptor,
} from "./fieldAnchors";
import type { StudioFieldBindingTargetV1, StudioFormTextTargetV1 } from "./studioDocumentAgentProtocol";
import {
  resolveStudioParagraphFieldBindings,
  type StudioParagraphFieldDocument,
} from "./studioParagraphFieldBindings";

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
  getSectionCount?(): number;
  getParagraphCount?(section: number): number;
  getParagraphLength?(section: number, paragraph: number): number;
  getTextRange?(section: number, paragraph: number, charOffset: number, count: number): string;
  getControlTextPositions?(section: number, paragraph: number): string;
  getFieldInfoAt?(section: number, paragraph: number, charOffset: number): string;
  getCharPropertiesAt?(section: number, paragraph: number, charOffset: number): string;
}

export type StudioFieldBindingResolution =
  | { fieldId: string; status: "unique"; target: StudioFieldBindingTargetV1; candidateCount: 1 }
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
  const paragraphResolutions = isParagraphFieldDocument(document)
    ? resolveStudioParagraphFieldBindings(document, fields)
    : fields.map((field) => ({
        fieldId: field.fieldId,
        status: "missing" as const,
        candidateCount: 0 as const,
      }));
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

  const resolved = tableResolutions.map((table, index): StudioFieldBindingResolution => {
    if (fields[index]?.position?.targetKind === "body_paragraph_text") {
      return paragraphResolutions[index]!;
    }
    if (table.status === "unique") {
      const target = table.anchor.target;
      const longText = normalizeFieldType(fields[index]?.fieldType) === "long_text";
      return {
        fieldId: table.fieldId,
        status: "unique",
        target: longText
          ? {
              kind: "table_cell_region",
              section: target.section,
              parentPara: target.parentPara,
              controlIndex: target.controlIndex,
              cellIndex: target.cellIndex,
            }
          : {
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
    const names = new Set([field.fieldKey, field.anchorLabel, field.label]
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

  for (let index = 0; index < resolved.length; index += 1) {
    if (resolved[index]?.status !== "missing") continue;
    resolved[index] = paragraphResolutions[index]!;
  }

  // 커서 selection은 문단 좌표까지만 제공하므로 한 문단에 복수 field가 결속되면 모두 보류한다.
  const paragraphOwners = new Map<string, number[]>();
  resolved.forEach((resolution, index) => {
    if (resolution.status !== "unique" || resolution.target.kind !== "body_paragraph_text") return;
    const key = `${resolution.target.section}:${resolution.target.paragraph}`;
    const owners = paragraphOwners.get(key) ?? [];
    owners.push(index);
    paragraphOwners.set(key, owners);
  });
  for (const owners of paragraphOwners.values()) {
    if (owners.length < 2) continue;
    for (const index of owners) {
      resolved[index] = {
        fieldId: fields[index]!.fieldId,
        status: "ambiguous",
        candidateCount: owners.length,
      };
    }
  }
  return resolved;
}

function isParagraphFieldDocument(document: StudioFieldBindingDocument): document is StudioFieldBindingDocument & StudioParagraphFieldDocument {
  return typeof document.getSectionCount === "function"
    && typeof document.getParagraphCount === "function"
    && typeof document.getParagraphLength === "function"
    && typeof document.getTextRange === "function"
    && typeof document.getControlTextPositions === "function"
    && typeof document.getFieldInfoAt === "function";
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

function normalizeFieldType(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase("en-US") ?? "";
}

function targetKey(target: StudioFormTextTargetV1): string {
  return `${target.section}:${target.paragraph}:${target.fieldId}`;
}
