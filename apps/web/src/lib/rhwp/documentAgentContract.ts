import { z } from "zod";

export const DOCUMENT_AGENT_SCHEMA_VERSION = "document-agent-v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface DocumentEditAnchor {
  kind: "body_paragraph";
  section: number;
  paragraph: number;
  charOffset: 0;
  length: number;
}

export interface DocumentAgentFormatSnapshot {
  charProperties: Record<string, unknown>;
  paragraphProperties: Record<string, unknown>;
  style: Record<string, unknown>;
}

/** RHWP Studio document-agent-command-v1이 exact preimage 검증에 사용하는 증거 해시다. */
export interface StudioDocumentAgentCommandEvidence {
  formatSha256: string;
  adjacentContextSha256: string;
}

export interface DocumentEditCandidate {
  schemaVersion: typeof DOCUMENT_AGENT_SCHEMA_VERSION;
  candidateId: string;
  sourceKey: string;
  documentSha256: string;
  reservedAnchorsSha256: string;
  anchor: DocumentEditAnchor;
  location: {
    page: number;
    label: string;
    box?: { x: number; y: number; width: number; height: number };
  };
  beforeText: string;
  beforeSha256: string;
  formatSnapshot: DocumentAgentFormatSnapshot;
  formatSha256: string;
  adjacentContext: string;
  adjacentContextSha256: string;
  studioCommandEvidence: StudioDocumentAgentCommandEvidence;
}

export interface DocumentAgentReservedAnchor {
  fieldId: string;
  target: {
    kind: "cell";
    section: number;
    parentPara: number;
    controlIndex: number;
    cellIndex: number;
    cellParagraph: number;
  };
}

export interface ExactEditCommand {
  schemaVersion: typeof DOCUMENT_AGENT_SCHEMA_VERSION;
  candidate: DocumentEditCandidate;
  replacement: string;
}

export interface ExactUndoCommand {
  schemaVersion: typeof DOCUMENT_AGENT_SCHEMA_VERSION;
  candidate: DocumentEditCandidate;
  afterText: string;
}

const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const finiteNumber = z.number().finite();

const anchorSchema = z.strictObject({
  kind: z.literal("body_paragraph"),
  section: nonnegativeInteger,
  paragraph: nonnegativeInteger,
  charOffset: z.literal(0),
  length: positiveInteger.max(4_000),
});

const boxSchema = z.strictObject({
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
});

const jsonObjectSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  try {
    canonicalJson(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "canonical JSON 객체가 아닙니다.",
    });
  }
});

const formatSnapshotSchema = z.strictObject({
  charProperties: jsonObjectSchema,
  paragraphProperties: jsonObjectSchema,
  style: jsonObjectSchema,
});

export const documentEditCandidateSchema = z.strictObject({
  schemaVersion: z.literal(DOCUMENT_AGENT_SCHEMA_VERSION),
  candidateId: z.string().regex(SHA256_PATTERN),
  sourceKey: z.string().trim().min(1).max(512),
  documentSha256: z.string().regex(SHA256_PATTERN),
  reservedAnchorsSha256: z.string().regex(SHA256_PATTERN),
  anchor: anchorSchema,
  location: z.strictObject({
    page: positiveInteger,
    label: z.string().min(1).max(200),
    box: boxSchema.optional(),
  }),
  beforeText: z.string().min(1).max(4_000),
  beforeSha256: z.string().regex(SHA256_PATTERN),
  formatSnapshot: formatSnapshotSchema,
  formatSha256: z.string().regex(SHA256_PATTERN),
  adjacentContext: z.string().max(700),
  adjacentContextSha256: z.string().regex(SHA256_PATTERN),
  studioCommandEvidence: z.strictObject({
    formatSha256: z.string().regex(SHA256_PATTERN),
    adjacentContextSha256: z.string().regex(SHA256_PATTERN),
  }),
});

export function decodeDocumentEditCandidate(value: unknown): DocumentEditCandidate {
  const parsed = documentEditCandidateSchema.parse(value);
  return {
    ...parsed,
    location: {
      page: parsed.location.page,
      label: parsed.location.label,
      ...(parsed.location.box ? { box: parsed.location.box } : {}),
    },
  };
}

/**
 * document-agent-v1의 content-addressed 값에 쓰는 canonical JSON이다.
 * object key를 정렬하고 -0을 0으로 정규화하며 undefined/non-finite/class instance를 거절한다.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에는 유한한 숫자만 사용할 수 있습니다.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") {
    throw new Error("canonical JSON에는 JSON 값만 사용할 수 있습니다.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical JSON 객체는 plain object여야 합니다.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/**
 * Studio 브리지의 format evidence는 Cunote의 전체 format snapshot hash와 의도적으로 다르다.
 * JSON key 순서도 공개 command-v1 계약의 일부이므로 canonicalJson으로 바꾸지 않는다.
 */
export function studioDocumentAgentFormatSha256(
  formatSnapshot: DocumentAgentFormatSnapshot,
): Promise<string> {
  const charShapeId = nonnegativeSafeId(formatSnapshot.charProperties.charShapeId, "charShapeId");
  const paraShapeId = nonnegativeSafeId(
    formatSnapshot.paragraphProperties.paraShapeId,
    "paraShapeId",
  );
  const styleId = nonnegativeSafeId(formatSnapshot.style.id, "styleId");
  return sha256Hex(JSON.stringify({
    schemaVersion: 1,
    charShapeId,
    paraShapeId,
    styleId,
  }));
}

export function candidateIdentityProjection(input: Omit<DocumentEditCandidate, "candidateId" | "location" | "beforeText" | "formatSnapshot" | "adjacentContext">): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    sourceKey: input.sourceKey,
    documentSha256: input.documentSha256,
    reservedAnchorsSha256: input.reservedAnchorsSha256,
    anchor: input.anchor,
    beforeSha256: input.beforeSha256,
    formatSha256: input.formatSha256,
    adjacentContextSha256: input.adjacentContextSha256,
    studioCommandEvidence: input.studioCommandEvidence,
  };
}

export async function documentEditCandidateId(
  input: Omit<DocumentEditCandidate, "candidateId" | "location" | "beforeText" | "formatSnapshot" | "adjacentContext">,
): Promise<string> {
  return canonicalSha256(candidateIdentityProjection(input));
}

export async function assertDocumentEditCandidateIntegrity(candidate: DocumentEditCandidate): Promise<void> {
  const [beforeSha256, formatSha256, adjacentContextSha256, studioFormatSha256] = await Promise.all([
    sha256Hex(candidate.beforeText),
    canonicalSha256(candidate.formatSnapshot),
    sha256Hex(candidate.adjacentContext),
    studioDocumentAgentFormatSha256(candidate.formatSnapshot),
  ]);
  if (
    beforeSha256 !== candidate.beforeSha256
    || formatSha256 !== candidate.formatSha256
    || adjacentContextSha256 !== candidate.adjacentContextSha256
    || studioFormatSha256 !== candidate.studioCommandEvidence.formatSha256
  ) {
    throw new Error("document agent candidate의 content hash가 맞지 않습니다.");
  }
  const candidateId = await documentEditCandidateId(candidate);
  if (candidateId !== candidate.candidateId) {
    throw new Error("document agent candidate ID가 canonical binding과 맞지 않습니다.");
  }
}

function nonnegativeSafeId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`RHWP ${label}가 nonnegative safe integer가 아닙니다.`);
  }
  return value as number;
}

export function assertSafeReplacement(value: string): void {
  if (value.length < 1 || value.length > 4_000) {
    throw new Error("AI 문서 치환문은 1자 이상 4,000자 이하여야 합니다.");
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("AI 문서 치환문에 허용되지 않는 제어 문자가 있습니다.");
  }
  if (/\r|\n|\u2028|\u2029/u.test(value)) {
    throw new Error("AI 문서 치환문은 문단 경계를 삽입할 수 없습니다.");
  }
}
