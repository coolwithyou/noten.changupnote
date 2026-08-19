import { isDocumentAgentSensitiveText } from "@/lib/documents/manualFieldPolicy";
import type { RhwpExactFieldAnchorResolution } from "./fieldAnchors";
import {
  DOCUMENT_AGENT_SCHEMA_VERSION,
  canonicalJson,
  canonicalSha256,
  decodeDocumentEditCandidate,
  documentEditCandidateId,
  sha256Hex,
  type DocumentAgentFormatSnapshot,
  type DocumentAgentReservedAnchor,
  type DocumentEditCandidate,
} from "./documentAgentContract";
import { buildStudioDocumentAgentCommandEvidence } from "./studioDocumentAgentProtocol";

const CONTEXT_SEPARATOR = "\n---\n";

interface CursorRect {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

interface SelectionRect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FieldInfo {
  inField: boolean;
  fieldId?: number;
  startCharIdx?: number;
  endCharIdx?: number;
  isGuide?: boolean;
  guideName?: string;
  editableInForm?: boolean;
}

export interface DocumentAgentCandidateDocument {
  pageCount(): number;
  getSectionCount(): number;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getTextRange(section: number, paragraph: number, charOffset: number, count: number): string;
  getCursorRect(section: number, paragraph: number, charOffset: number): string;
  getSelectionRects(
    section: number,
    startParagraph: number,
    startCharOffset: number,
    endParagraph: number,
    endCharOffset: number,
  ): string;
  getControlTextPositions(section: number, paragraph: number): string;
  getFieldInfoAt(section: number, paragraph: number, charOffset: number): string;
  getCharPropertiesAt(section: number, paragraph: number, charOffset: number): string;
  getParaPropertiesAt(section: number, paragraph: number): string;
  getStyleAt(section: number, paragraph: number): string;
}

export class DocumentAgentCandidateScanError extends Error {
  readonly code: "invalid_input" | "non_monotonic_layout" | "reserved_anchor_unresolved";

  constructor(
    code: "invalid_input" | "non_monotonic_layout" | "reserved_anchor_unresolved",
    message: string,
  ) {
    super(message);
    this.name = "DocumentAgentCandidateScanError";
    this.code = code;
  }
}

export function reservedAnchorsFromExactResolutions(
  resolutions: readonly RhwpExactFieldAnchorResolution[],
): DocumentAgentReservedAnchor[] {
  const unresolved = resolutions.find((resolution) => resolution.status !== "unique");
  if (unresolved) {
    throw new DocumentAgentCandidateScanError(
      "reserved_anchor_unresolved",
      `연결 필드 ${unresolved.fieldId}의 구조 위치가 ${unresolved.status} 상태입니다.`,
    );
  }
  return resolutions.map((resolution) => {
    if (resolution.status !== "unique") throw new Error("unreachable exact anchor state");
    const target = resolution.anchor.target;
    return {
      fieldId: resolution.fieldId,
      target: {
        kind: "cell",
        section: target.section,
        parentPara: target.parentPara,
        controlIndex: target.controlIndex,
        cellIndex: target.cellIndex,
        cellParagraph: target.cellParagraph,
      },
    };
  });
}

export function reservedAnchorProjection(anchors: readonly DocumentAgentReservedAnchor[]): DocumentAgentReservedAnchor[] {
  return anchors
    .map((anchor) => ({
      fieldId: anchor.fieldId,
      target: { ...anchor.target },
    }))
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId, "en")
      || left.target.section - right.target.section
      || left.target.parentPara - right.target.parentPara
      || left.target.controlIndex - right.target.controlIndex
      || left.target.cellIndex - right.target.cellIndex
      || left.target.cellParagraph - right.target.cellParagraph);
}

export async function reservedAnchorsSha256(anchors: readonly DocumentAgentReservedAnchor[]): Promise<string> {
  return canonicalSha256(reservedAnchorProjection(anchors));
}

export async function extractDocumentEditCandidates(input: {
  document: DocumentAgentCandidateDocument;
  sourceKey: string;
  documentSha256: string;
  selectedPage: number;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
  maxCandidates?: number;
}): Promise<DocumentEditCandidate[]> {
  if (!Number.isInteger(input.selectedPage) || input.selectedPage < 1 || input.selectedPage > input.document.pageCount()) {
    throw new DocumentAgentCandidateScanError("invalid_input", "선택한 쪽 번호가 현재 문서 범위를 벗어났습니다.");
  }
  const maxCandidates = input.maxCandidates ?? 24;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 24) {
    throw new DocumentAgentCandidateScanError("invalid_input", "후보 개수 상한은 1..24여야 합니다.");
  }
  const reservedSha256 = await reservedAnchorsSha256(input.reservedAnchors);
  const candidates: DocumentEditCandidate[] = [];
  let lastPageIndex = -1;
  for (let section = 0; section < input.document.getSectionCount(); section += 1) {
    const paragraphCount = input.document.getParagraphCount(section);
    for (let paragraph = 0; paragraph < paragraphCount; paragraph += 1) {
      const length = input.document.getParagraphLength(section, paragraph);
      const cursor = decodeCursorRect(input.document.getCursorRect(section, paragraph, 0));
      if (!cursor) continue;
      if (cursor.pageIndex < lastPageIndex) {
        throw new DocumentAgentCandidateScanError(
          "non_monotonic_layout",
          "본문 문단의 쪽 순서가 역행해 안전 후보 탐색을 중단했습니다.",
        );
      }
      lastPageIndex = cursor.pageIndex;
      const page = cursor.pageIndex + 1;
      if (page > input.selectedPage) return candidates;
      if (page !== input.selectedPage || length < 1 || length > 4_000) continue;
      const candidate = await validateBodyParagraphCandidate({
        ...input,
        reservedAnchorsSha256: reservedSha256,
        anchor: { section, paragraph },
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) return candidates;
    }
  }
  return candidates;
}

export async function validateBodyParagraphCandidate(input: {
  document: DocumentAgentCandidateDocument;
  sourceKey: string;
  documentSha256: string;
  selectedPage: number;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
  reservedAnchorsSha256?: string;
  anchor: { section: number; paragraph: number };
}): Promise<DocumentEditCandidate | null> {
  const { section, paragraph } = input.anchor;
  if (!Number.isInteger(section) || !Number.isInteger(paragraph) || section < 0 || paragraph < 0) return null;
  if (section >= input.document.getSectionCount() || paragraph >= input.document.getParagraphCount(section)) return null;
  const length = input.document.getParagraphLength(section, paragraph);
  if (!Number.isInteger(length) || length < 1 || length > 4_000) return null;
  if (input.reservedAnchors.some((reserved) => (
    reserved.target.section === section && reserved.target.parentPara === paragraph
  ))) return null;

  const beforeText = input.document.getTextRange(section, paragraph, 0, length);
  if (!beforeText.trim() || beforeText.length > 4_000) return null;
  const controls = decodeNonnegativeIntegerArray(input.document.getControlTextPositions(section, paragraph));
  if (!controls || controls.length > 0) return null;

  const charProperties: Record<string, unknown>[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const field = decodeFieldInfo(input.document.getFieldInfoAt(section, paragraph, offset));
    if (!field || field.inField) return null;
    const properties = decodePlainObject(input.document.getCharPropertiesAt(section, paragraph, offset));
    if (!properties) return null;
    charProperties.push(properties);
  }
  const endField = decodeFieldInfo(input.document.getFieldInfoAt(section, paragraph, length));
  if (!endField || endField.inField) return null;
  const firstCharProperties = charProperties[0]!;
  const firstCharCanonical = canonicalJson(firstCharProperties);
  if (charProperties.some((properties) => canonicalJson(properties) !== firstCharCanonical)) return null;

  const paragraphProperties = decodePlainObject(input.document.getParaPropertiesAt(section, paragraph));
  const style = decodePlainObject(input.document.getStyleAt(section, paragraph));
  if (!paragraphProperties || !style) return null;
  const formatSnapshot: DocumentAgentFormatSnapshot = {
    charProperties: firstCharProperties,
    paragraphProperties,
    style,
  };

  const startCursor = decodeCursorRect(input.document.getCursorRect(section, paragraph, 0));
  const endCursor = decodeCursorRect(input.document.getCursorRect(section, paragraph, length));
  const rects = decodeSelectionRects(input.document.getSelectionRects(section, paragraph, 0, paragraph, length));
  if (!startCursor || !endCursor || !rects || rects.length === 0) return null;
  const pageIndex = input.selectedPage - 1;
  if (startCursor.pageIndex !== pageIndex || endCursor.pageIndex !== pageIndex) return null;
  if (rects.some((rect) => rect.pageIndex !== pageIndex)) return null;

  const adjacentContext = adjacentContextFor(input.document, section, paragraph);
  if (isDocumentAgentSensitiveText(`${beforeText}${CONTEXT_SEPARATOR}${adjacentContext}`)) return null;
  const target = {
    kind: "body_paragraph" as const,
    section,
    paragraph,
    charOffset: 0 as const,
    length,
  };
  const [beforeSha256, formatSha256, adjacentContextSha256, studioCommandEvidence] = await Promise.all([
    sha256Hex(beforeText),
    canonicalSha256(formatSnapshot),
    sha256Hex(adjacentContext),
    buildStudioDocumentAgentCommandEvidence({
      document: input.document,
      target,
      formatSnapshot,
    }),
  ]);
  const reservedSha256 = input.reservedAnchorsSha256 ?? await reservedAnchorsSha256(input.reservedAnchors);
  const identity = {
    schemaVersion: DOCUMENT_AGENT_SCHEMA_VERSION,
    sourceKey: input.sourceKey,
    documentSha256: input.documentSha256,
    reservedAnchorsSha256: reservedSha256,
    anchor: target,
    beforeSha256,
    formatSha256,
    adjacentContextSha256,
    studioCommandEvidence,
  };
  const candidateId = await documentEditCandidateId(identity);
  const candidate: DocumentEditCandidate = {
    schemaVersion: DOCUMENT_AGENT_SCHEMA_VERSION,
    candidateId,
    sourceKey: input.sourceKey,
    documentSha256: input.documentSha256,
    reservedAnchorsSha256: reservedSha256,
    anchor: target,
    location: {
      page: input.selectedPage,
      label: `본문 ${section + 1}구역 ${paragraph + 1}문단`,
      box: mergeSelectionRects(rects),
    },
    beforeText,
    beforeSha256,
    formatSnapshot,
    formatSha256,
    adjacentContext,
    adjacentContextSha256,
    studioCommandEvidence,
  };
  return decodeDocumentEditCandidate(candidate);
}

function adjacentContextFor(
  document: DocumentAgentCandidateDocument,
  section: number,
  paragraph: number,
): string {
  const paragraphCount = document.getParagraphCount(section);
  let previous = "";
  let next = "";
  for (let index = paragraph - 1; index >= 0; index -= 1) {
    const text = paragraphText(document, section, index).trim();
    if (text) {
      previous = text.slice(-300);
      break;
    }
  }
  for (let index = paragraph + 1; index < paragraphCount; index += 1) {
    const text = paragraphText(document, section, index).trim();
    if (text) {
      next = text.slice(0, 300);
      break;
    }
  }
  return `${previous}${CONTEXT_SEPARATOR}${next}`;
}

function paragraphText(document: DocumentAgentCandidateDocument, section: number, paragraph: number): string {
  const length = document.getParagraphLength(section, paragraph);
  return length > 0 ? document.getTextRange(section, paragraph, 0, length) : "";
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isStrictObject(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function decodePlainObject(value: string): Record<string, unknown> | null {
  const parsed = decodeJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return null;
  }
  try {
    canonicalJson(parsed);
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeCursorRect(value: string): CursorRect | null {
  const parsed = decodeJson(value);
  if (!isStrictObject(parsed, ["pageIndex", "x", "y", "height"])) return null;
  if (!Number.isInteger(parsed.pageIndex) || (parsed.pageIndex as number) < 0) return null;
  if (![parsed.x, parsed.y, parsed.height].every((number) => typeof number === "number" && Number.isFinite(number))) {
    return null;
  }
  return parsed as unknown as CursorRect;
}

function decodeSelectionRects(value: string): SelectionRect[] | null {
  const parsed = decodeJson(value);
  if (!Array.isArray(parsed)) return null;
  const rects: SelectionRect[] = [];
  for (const item of parsed) {
    if (!isStrictObject(item, ["pageIndex", "x", "y", "width", "height"])) return null;
    if (!Number.isInteger(item.pageIndex) || (item.pageIndex as number) < 0) return null;
    if (![item.x, item.y, item.width, item.height]
      .every((number) => typeof number === "number" && Number.isFinite(number))) return null;
    if ((item.width as number) <= 0 || (item.height as number) <= 0) return null;
    rects.push(item as unknown as SelectionRect);
  }
  return rects;
}

function decodeNonnegativeIntegerArray(value: string): number[] | null {
  const parsed = decodeJson(value);
  return Array.isArray(parsed) && parsed.every((item) => Number.isInteger(item) && item >= 0)
    ? parsed as number[]
    : null;
}

function decodeFieldInfo(value: string): FieldInfo | null {
  const parsed = decodeJson(value);
  const keys = ["inField", "fieldId", "startCharIdx", "endCharIdx", "isGuide", "guideName", "editableInForm"];
  if (!isStrictObject(parsed, keys) || typeof parsed.inField !== "boolean") return null;
  for (const key of ["fieldId", "startCharIdx", "endCharIdx"] as const) {
    if (parsed[key] !== undefined && (!Number.isInteger(parsed[key]) || (parsed[key] as number) < 0)) return null;
  }
  for (const key of ["isGuide", "editableInForm"] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") return null;
  }
  if (parsed.guideName !== undefined && typeof parsed.guideName !== "string") return null;
  return parsed as unknown as FieldInfo;
}

function mergeSelectionRects(rects: readonly SelectionRect[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}
