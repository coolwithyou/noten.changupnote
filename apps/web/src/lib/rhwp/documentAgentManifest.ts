import {
  canonicalJson,
  canonicalSha256,
  sha256Hex,
  type DocumentAgentFormatSnapshot,
  type DocumentEditAnchor,
} from "./documentAgentContract";
import type { DocumentAgentCandidateDocument } from "./documentAgentCandidates";

export interface DocumentAgentManifestParagraph {
  section: number;
  paragraph: number;
  length: number;
  textSha256: string;
  controlPositions: number[];
  controlPositionsSha256: string;
  paragraphPropertiesSha256: string;
  styleSha256: string;
  charPropertiesSha256: string;
  uniformFormatSha256: string | null;
}

export interface DocumentAgentSemanticManifest {
  schemaVersion: "document-agent-semantic-manifest-v1";
  pageCount: number;
  sectionCount: number;
  paragraphCounts: number[];
  documentInfoSha256: string;
  paragraphs: DocumentAgentManifestParagraph[];
}

export interface DocumentAgentManifestDocument extends DocumentAgentCandidateDocument {
  getDocumentInfo(): string;
}

export async function buildDocumentAgentSemanticManifest(
  document: DocumentAgentManifestDocument,
): Promise<DocumentAgentSemanticManifest> {
  const sectionCount = document.getSectionCount();
  const pageCount = document.pageCount();
  if (!Number.isInteger(sectionCount) || sectionCount < 1 || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("RHWP 문서의 section/page count가 유효하지 않습니다.");
  }
  const documentInfo = parseCanonicalObject(document.getDocumentInfo(), "document info");
  const paragraphCounts: number[] = [];
  const paragraphs: DocumentAgentManifestParagraph[] = [];
  for (let section = 0; section < sectionCount; section += 1) {
    const paragraphCount = document.getParagraphCount(section);
    if (!Number.isInteger(paragraphCount) || paragraphCount < 0) {
      throw new Error("RHWP 문서의 paragraph count가 유효하지 않습니다.");
    }
    paragraphCounts.push(paragraphCount);
    for (let paragraph = 0; paragraph < paragraphCount; paragraph += 1) {
      paragraphs.push(await paragraphManifest(document, section, paragraph));
    }
  }
  return {
    schemaVersion: "document-agent-semantic-manifest-v1",
    pageCount,
    sectionCount,
    paragraphCounts,
    documentInfoSha256: await canonicalSha256(documentInfo),
    paragraphs,
  };
}

export function assertDocumentAgentManifestsEqual(
  expected: DocumentAgentSemanticManifest,
  actual: DocumentAgentSemanticManifest,
  message = "RHWP export/reopen semantic manifest가 달라졌습니다.",
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error(message);
}

export function assertDocumentAgentTargetMutation(input: {
  before: DocumentAgentSemanticManifest;
  after: DocumentAgentSemanticManifest;
  target: DocumentEditAnchor;
  expectedTextSha256: string;
  expectedFormatSha256: string;
}): void {
  const before = input.before;
  const after = input.after;
  if (
    before.schemaVersion !== after.schemaVersion
    || before.pageCount !== after.pageCount
    || before.sectionCount !== after.sectionCount
    || canonicalJson(before.paragraphCounts) !== canonicalJson(after.paragraphCounts)
    || before.documentInfoSha256 !== after.documentInfoSha256
    || before.paragraphs.length !== after.paragraphs.length
  ) {
    throw new Error("AI 문서 치환이 문서 전체 구조 또는 페이지 수를 바꿨습니다.");
  }
  let foundTarget = false;
  for (let index = 0; index < before.paragraphs.length; index += 1) {
    const previous = before.paragraphs[index]!;
    const current = after.paragraphs[index]!;
    const isTarget = previous.section === input.target.section && previous.paragraph === input.target.paragraph;
    if (!isTarget) {
      if (canonicalJson(previous) !== canonicalJson(current)) {
        throw new Error(`AI 문서 치환이 대상 밖 ${previous.section}:${previous.paragraph} 문단을 바꿨습니다.`);
      }
      continue;
    }
    foundTarget = true;
    if (
      current.section !== previous.section
      || current.paragraph !== previous.paragraph
      || current.textSha256 !== input.expectedTextSha256
      || current.uniformFormatSha256 !== input.expectedFormatSha256
      || current.controlPositionsSha256 !== previous.controlPositionsSha256
      || current.paragraphPropertiesSha256 !== previous.paragraphPropertiesSha256
      || current.styleSha256 !== previous.styleSha256
    ) {
      throw new Error("AI 문서 치환 뒤 target text/format/control invariant가 맞지 않습니다.");
    }
  }
  if (!foundTarget) throw new Error("semantic manifest에서 AI 문서 치환 target을 찾지 못했습니다.");
}

async function paragraphManifest(
  document: DocumentAgentManifestDocument,
  section: number,
  paragraph: number,
): Promise<DocumentAgentManifestParagraph> {
  const length = document.getParagraphLength(section, paragraph);
  if (!Number.isInteger(length) || length < 0) throw new Error("RHWP 문단 길이가 유효하지 않습니다.");
  const text = length > 0 ? document.getTextRange(section, paragraph, 0, length) : "";
  const controls = parseIntegerArray(document.getControlTextPositions(section, paragraph));
  const paragraphProperties = parseCanonicalObject(
    document.getParaPropertiesAt(section, paragraph),
    "paragraph properties",
  );
  const style = parseCanonicalObject(document.getStyleAt(section, paragraph), "style");
  const charProperties: Record<string, unknown>[] = [];
  const offsets = length > 0 ? Array.from({ length }, (_, index) => index) : [0];
  for (const offset of offsets) {
    charProperties.push(parseCanonicalObject(
      document.getCharPropertiesAt(section, paragraph, offset),
      "character properties",
    ));
  }
  const first = charProperties[0]!;
  const firstCanonical = canonicalJson(first);
  const uniform = charProperties.every((properties) => canonicalJson(properties) === firstCanonical);
  const formatSnapshot: DocumentAgentFormatSnapshot = {
    charProperties: first,
    paragraphProperties,
    style,
  };
  return {
    section,
    paragraph,
    length,
    textSha256: await sha256Hex(text),
    controlPositions: controls,
    controlPositionsSha256: await canonicalSha256(controls),
    paragraphPropertiesSha256: await canonicalSha256(paragraphProperties),
    styleSha256: await canonicalSha256(style),
    charPropertiesSha256: await canonicalSha256(charProperties),
    uniformFormatSha256: uniform ? await canonicalSha256(formatSnapshot) : null,
  };
}

function parseCanonicalObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`RHWP ${label} JSON을 해석하지 못했습니다.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error(`RHWP ${label}가 plain object가 아닙니다.`);
  }
  canonicalJson(parsed);
  return parsed as Record<string, unknown>;
}

function parseIntegerArray(value: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("RHWP control positions JSON을 해석하지 못했습니다.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error("RHWP control positions가 nonnegative integer array가 아닙니다.");
  }
  return parsed as number[];
}
