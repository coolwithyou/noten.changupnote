import { sha256Hex, stableJson } from "./sourceRevision";

const SOURCE_BLOCK_PATTERN =
  /^<<<DEEP_ANALYSIS_SOURCE id="([^"]+)" kind="(structured|attachment)" sha256="([0-9a-f]{64})">>>\n([\s\S]*?)\n<<<END_DEEP_ANALYSIS_SOURCE>>>$/gm;
const MAX_DISPLAY_CHARS = 900;

interface AuditEvidenceReference {
  id: string;
  sourceId: string;
  sourceKind: "structured" | "attachment";
  exactText: string;
  displayText: string;
}

export interface DeepAnalysisAuditEvidenceCatalog {
  promptText: string;
  resolveCriteria(rows: unknown): {
    criteria: unknown[];
    unresolvedReferences: string[];
  };
}

/**
 * Audit 모델이 sealed 원문을 다시 쓰지 않고 안정적인 ID만 선택하게 하는 경계다.
 * ID 생성, structured JSON 평탄화, exact span 해석은 이 모듈 안에 감춘다.
 */
export function createDeepAnalysisAuditEvidenceCatalog(
  evidenceText: string,
): DeepAnalysisAuditEvidenceCatalog {
  const references = buildReferences(evidenceText);
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  return {
    promptText: renderReferences(references),
    resolveCriteria(rows) {
      if (!Array.isArray(rows)) {
        return { criteria: [], unresolvedReferences: [] };
      }
      const unresolvedReferences = new Set<string>();
      const criteria = rows.map((row) => {
        if (!isRecord(row)) return row;
        const primarySourceRef = cleanString(row.primary_source_ref);
        const primary = primarySourceRef
          ? referenceById.get(primarySourceRef) ?? null
          : null;
        let rowHasUnresolvedReference = false;
        if (primarySourceRef && !primary) {
          unresolvedReferences.add(primarySourceRef);
          rowHasUnresolvedReference = true;
        }
        if (!primarySourceRef) {
          unresolvedReferences.add("<missing-primary_source_ref>");
          rowHasUnresolvedReference = true;
        }

        const supportingSourceRefs = Array.isArray(row.supporting_source_refs)
          ? row.supporting_source_refs
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim())
          : [];
        const supportingSourceSpans: string[] = [];
        for (const referenceId of [...new Set(supportingSourceRefs)]) {
          const reference = referenceById.get(referenceId);
          if (!reference) {
            unresolvedReferences.add(referenceId);
            rowHasUnresolvedReference = true;
            continue;
          }
          supportingSourceSpans.push(reference.exactText);
        }

        const value = isRecord(row.value) ? row.value : {};
        return {
          ...row,
          value: row.operator === "text_only" && primary
            ? { ...value, note: primary.displayText }
            : value,
          source_span: !rowHasUnresolvedReference && primary ? primary.exactText : "",
          supporting_source_spans: supportingSourceSpans,
        };
      });
      return {
        criteria,
        unresolvedReferences: [...unresolvedReferences].sort(),
      };
    },
  };
}

function buildReferences(evidenceText: string): AuditEvidenceReference[] {
  const references: AuditEvidenceReference[] = [];
  for (const match of evidenceText.matchAll(SOURCE_BLOCK_PATTERN)) {
    const [, sourceId, sourceKind, , text] = match;
    if (
      !sourceId
      || (sourceKind !== "structured" && sourceKind !== "attachment")
      || text === undefined
    ) continue;
    references.push(...buildSourceReferences({
      sourceId,
      sourceKind,
      text,
    }));
  }
  if (references.length > 0) return references;
  return buildSourceReferences({
    sourceId: "unwrapped",
    sourceKind: isJsonDocument(evidenceText) ? "structured" : "attachment",
    text: evidenceText,
  });
}

function isJsonDocument(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function buildSourceReferences(input: {
  sourceId: string;
  sourceKind: "structured" | "attachment";
  text: string;
}): AuditEvidenceReference[] {
  if (input.sourceKind === "structured") {
    try {
      const parsed = JSON.parse(input.text) as unknown;
      const flattened = flattenStructuredValue(parsed);
      const structured = flattened.flatMap((item) => (
        splitDisplayText(item.displayText).flatMap((segment, segmentIndex) => {
          const exactText = typeof item.value === "string"
            ? JSON.stringify(segment).slice(1, -1)
            : segment;
          return makeReference({
            ...input,
            discriminator: `${item.path}:${segmentIndex}`,
            exactText,
            displayText: `${item.path} = ${segment}`,
          });
        })
      ));
      if (structured.length > 0) return structured;
    } catch {
      // structuredText가 JSON이 아닌 기존 입력도 일반 sealed text로 안전하게 처리한다.
    }
  }

  const references: AuditEvidenceReference[] = [];
  let lineIndex = 0;
  for (const rawLine of input.text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      lineIndex += 1;
      continue;
    }
    for (const [segmentIndex, segment] of splitDisplayText(trimmed).entries()) {
      references.push(...makeReference({
        ...input,
        discriminator: `${lineIndex}:${segmentIndex}`,
        exactText: segment,
        displayText: segment,
      }));
    }
    lineIndex += 1;
  }
  return references;
}

function flattenStructuredValue(
  value: unknown,
  path = "$",
): Array<{ path: string; value: string | number | boolean; displayText: string }> {
  if (typeof value === "string") {
    const displayText = value.trim();
    return displayText.length >= 2 ? [{ path, value, displayText }] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [{ path, value, displayText: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenStructuredValue(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (
    flattenStructuredValue(item, `${path}.${key}`)
  ));
}

function splitDisplayText(text: string): string[] {
  if (text.length <= MAX_DISPLAY_CHARS) return text.length >= 2 ? [text] : [];
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= MAX_DISPLAY_CHARS) {
      const tail = text.slice(start).trim();
      if (tail.length >= 2) segments.push(tail);
      break;
    }
    const window = text.slice(start, start + MAX_DISPLAY_CHARS);
    const boundary = Math.max(
      window.lastIndexOf("다. "),
      window.lastIndexOf(". "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" | "),
      window.lastIndexOf("\t"),
      window.lastIndexOf(" "),
    );
    const length = boundary >= Math.floor(MAX_DISPLAY_CHARS / 2)
      ? boundary + 1
      : MAX_DISPLAY_CHARS;
    const segment = text.slice(start, start + length).trim();
    if (segment.length >= 2) segments.push(segment);
    start += length;
    while (text[start] === " ") start += 1;
  }
  return segments;
}

function makeReference(input: {
  sourceId: string;
  sourceKind: "structured" | "attachment";
  discriminator: string;
  exactText: string;
  displayText: string;
}): AuditEvidenceReference[] {
  if (
    input.exactText.length < 2
    || input.displayText.length < 2
  ) return [];
  const id = `ev_${sha256Hex(stableJson({
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
    discriminator: input.discriminator,
    exactText: input.exactText,
  })).slice(0, 16)}`;
  return [{
    id,
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
    exactText: input.exactText,
    displayText: input.displayText,
  }];
}

function renderReferences(references: AuditEvidenceReference[]): string {
  if (references.length === 0) return "AUDIT_EVIDENCE_CATALOG_EMPTY";
  const grouped = new Map<string, AuditEvidenceReference[]>();
  for (const reference of references) {
    const key = `${reference.sourceKind}:${reference.sourceId}`;
    const group = grouped.get(key) ?? [];
    group.push(reference);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([source, group]) => [
    `<<<AUDIT_EVIDENCE source="${source}">>>`,
    ...group.map((reference) => `[${reference.id}] ${reference.displayText}`),
    "<<<END_AUDIT_EVIDENCE>>>",
  ].join("\n")).join("\n\n");
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
