import type { RhwpFieldDescriptor } from "./fieldAnchors";
import { canonicalJson } from "./documentAgentContract";
import type {
  StudioBodyParagraphTargetV1,
  StudioParagraphFieldTargetV1,
} from "./studioDocumentAgentProtocol";

export interface StudioParagraphFieldDocument {
  getSectionCount(): number;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getTextRange(section: number, paragraph: number, charOffset: number, count: number): string;
  getControlTextPositions(section: number, paragraph: number): string;
  getFieldInfoAt(section: number, paragraph: number, charOffset: number): string;
  getCharPropertiesAt?(section: number, paragraph: number, charOffset: number): string;
}

export type StudioParagraphFieldResolution =
  | { fieldId: string; status: "unique"; target: StudioParagraphFieldTargetV1; candidateCount: 1 }
  | { fieldId: string; status: "missing"; candidateCount: 0 }
  | { fieldId: string; status: "ambiguous"; candidateCount: number };

interface ParagraphTemplate {
  prefix: string;
  suffix: string;
  occurrence: number;
}

/**
 * 분석기의 prefix/value/suffix 계약을 현재 RHWP 본문 좌표로 재결속한다.
 * 값만 달라질 수 있고 prefix/suffix·비제어 문단 조건은 exact해야 한다.
 */
export function resolveStudioParagraphFieldBindings(
  document: StudioParagraphFieldDocument,
  fields: readonly RhwpFieldDescriptor[],
): StudioParagraphFieldResolution[] {
  return fields.map((field) => {
    const template = parseParagraphTemplate(field.position);
    if (!template) return { fieldId: field.fieldId, status: "missing", candidateCount: 0 };
    const candidates: StudioParagraphFieldTargetV1[] = [];
    for (let section = 0; section < document.getSectionCount(); section += 1) {
      for (let paragraph = 0; paragraph < document.getParagraphCount(section); paragraph += 1) {
        const length = document.getParagraphLength(section, paragraph);
        if (!Number.isSafeInteger(length) || length < 1 || length > 4_000) continue;
        const text = document.getTextRange(section, paragraph, 0, length);
        const range = resolveTemplateValueRange(text, template);
        if (!range) continue;
        const { valueStart, valueEnd } = range;
        if (valueEnd < valueStart || !isPlainBodyParagraph(document, section, paragraph, length)) continue;
        candidates.push({
          kind: "body_paragraph_text",
          section,
          paragraph,
          length,
          valueStart,
          valueEnd,
        });
      }
    }
    const target = candidates[template.occurrence];
    if (target) return { fieldId: field.fieldId, status: "unique", target, candidateCount: 1 };
    if (candidates.length === 0) return { fieldId: field.fieldId, status: "missing", candidateCount: 0 };
    return { fieldId: field.fieldId, status: "ambiguous", candidateCount: candidates.length };
  });
}

/** 한 문단의 현재 값 범위만 바꾸고 분석기가 봉인한 prefix/suffix는 그대로 둔다. */
export function buildStudioParagraphFieldReplacement(
  beforeText: string,
  target: StudioParagraphFieldTargetV1,
  value: string,
): string {
  if (beforeText.length !== target.length
      || target.valueStart > target.valueEnd
      || target.valueEnd > beforeText.length) {
    throw new Error("paragraph field binding과 현재 문단 길이가 다릅니다.");
  }
  const prefix = beforeText.slice(0, target.valueStart);
  const suffix = beforeText.slice(target.valueEnd);
  const trimmed = value.trim();
  const leading = prefix.length > 0 && !/\s$/u.test(prefix) ? " " : "";
  const trailing = suffix.length > 0 && !/^\s/u.test(suffix) ? " " : "";
  return `${prefix}${leading}${trimmed}${trailing}${suffix}`;
}

export function studioBodyParagraphTargetForField(
  target: StudioParagraphFieldTargetV1,
  length = target.length,
): StudioBodyParagraphTargetV1 {
  return {
    kind: "body_paragraph",
    section: target.section,
    paragraph: target.paragraph,
    charOffset: 0,
    length,
  };
}

function parseParagraphTemplate(position: Record<string, unknown> | null | undefined): ParagraphTemplate | null {
  if (position?.targetKind !== "body_paragraph_text") return null;
  const prefix = position.paragraphPrefix;
  const suffix = position.paragraphSuffix;
  const occurrence = position.paragraphOccurrence;
  if (typeof prefix !== "string" || typeof suffix !== "string") return null;
  if (!Number.isSafeInteger(occurrence) || (occurrence as number) < 0) return null;
  if (prefix.length + suffix.length < 2 || prefix.length + suffix.length > 4_000) return null;
  return { prefix, suffix, occurrence: occurrence as number };
}

function isPlainBodyParagraph(
  document: StudioParagraphFieldDocument,
  section: number,
  paragraph: number,
  length: number,
): boolean {
  try {
    const controls = JSON.parse(document.getControlTextPositions(section, paragraph)) as unknown;
    if (!Array.isArray(controls) || controls.length > 0) return false;
    for (const offset of [0, length]) {
      const field = JSON.parse(document.getFieldInfoAt(section, paragraph, offset)) as { inField?: unknown };
      if (field.inField !== false) return false;
    }
    if (document.getCharPropertiesAt) {
      const first = canonicalJson(JSON.parse(document.getCharPropertiesAt(section, paragraph, 0)) as unknown);
      for (let offset = 1; offset < length; offset += 1) {
        const current = canonicalJson(JSON.parse(document.getCharPropertiesAt(section, paragraph, offset)) as unknown);
        if (current !== first) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function resolveTemplateValueRange(text: string, template: ParagraphTemplate): {
  valueStart: number;
  valueEnd: number;
} | null {
  const prefix = new RegExp(`^[ \\t\\u00a0]*${flexibleWhitespacePattern(template.prefix)}`, "u").exec(text);
  if (!prefix) return null;
  const valueStart = prefix[0].length;
  if (template.suffix.length === 0) return { valueStart, valueEnd: text.length };
  const suffix = new RegExp(`${flexibleWhitespacePattern(template.suffix)}[ \\t\\u00a0]*$`, "u").exec(text);
  if (!suffix || suffix.index < valueStart) return null;
  return { valueStart, valueEnd: suffix.index };
}

function flexibleWhitespacePattern(value: string): string {
  return value
    .split(/([ \t\u00a0]+)/u)
    .filter(Boolean)
    .map(part => /^[ \t\u00a0]+$/u.test(part) ? "[ \\t\\u00a0]+" : escapeRegExp(part))
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
