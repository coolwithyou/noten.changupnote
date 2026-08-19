import { z } from "zod";
import {
  sha256Hex,
  studioDocumentAgentFormatSha256,
  type DocumentAgentFormatSnapshot,
  type DocumentEditAnchor,
  type StudioDocumentAgentCommandEvidence,
} from "./documentAgentContract";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const safeInteger = z.number().int().refine(Number.isSafeInteger, "safe integer여야 합니다.");
const nonnegativeSafeInteger = safeInteger.nonnegative();
const positiveSafeInteger = safeInteger.positive();

export const studioBodyParagraphTargetSchema = z.strictObject({
  kind: z.literal("body_paragraph"),
  section: nonnegativeSafeInteger,
  paragraph: nonnegativeSafeInteger,
  charOffset: z.literal(0),
  length: nonnegativeSafeInteger.max(4_000),
});

export const studioDocumentStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.enum(["hwp", "hwpx"]),
  documentEpoch: positiveSafeInteger,
  changeSeq: nonnegativeSafeInteger,
  dirty: z.boolean(),
  pageCount: positiveSafeInteger,
  documentSha256: sha256Schema,
});

export const studioSelectionContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentEpoch: positiveSafeInteger,
  changeSeq: nonnegativeSafeInteger,
  page: positiveSafeInteger,
  editable: z.boolean(),
  collapsed: z.boolean(),
  target: studioBodyParagraphTargetSchema.nullable(),
  selectedTextSha256: sha256Schema.nullable(),
});

export const studioApplyTextCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1).max(128),
  expectedDocumentEpoch: positiveSafeInteger,
  expectedChangeSeq: nonnegativeSafeInteger,
  expectedDocumentSha256: sha256Schema,
  target: studioBodyParagraphTargetSchema,
  expectedBeforeSha256: sha256Schema,
  expectedFormatSha256: sha256Schema,
  expectedAdjacentContextSha256: sha256Schema,
  replacement: z.string().max(4_000).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "replacement에 control 문자를 넣을 수 없습니다.",
  ),
});

export const studioRevertTextCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1).max(128),
  expectedDocumentEpoch: positiveSafeInteger,
  expectedChangeSeq: nonnegativeSafeInteger,
  expectedAfterDocumentSha256: sha256Schema,
  expectedAfterSha256: sha256Schema,
});

export const studioTextCommandReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1).max(128),
  operation: z.enum(["apply", "revert"]),
  documentEpoch: positiveSafeInteger,
  beforeChangeSeq: nonnegativeSafeInteger,
  afterChangeSeq: positiveSafeInteger,
  beforeDocumentSha256: sha256Schema,
  afterDocumentSha256: sha256Schema,
  beforeTextSha256: sha256Schema,
  afterTextSha256: sha256Schema,
  formatSha256: sha256Schema,
  adjacentContextSha256: sha256Schema,
  pageCountBefore: positiveSafeInteger,
  pageCountAfter: positiveSafeInteger,
  target: studioBodyParagraphTargetSchema,
}).superRefine((receipt, context) => {
  if (receipt.afterChangeSeq !== receipt.beforeChangeSeq + 1) {
    context.addIssue({ code: "custom", message: "receipt change sequence가 연속되지 않습니다." });
  }
});

export const studioFocusTargetResultSchema = z.strictObject({
  focused: z.boolean(),
  page: positiveSafeInteger,
});

export const studioDocumentChangedEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reason: z.enum(["agent_apply", "agent_revert"]),
  documentEpoch: positiveSafeInteger,
  changeSeq: positiveSafeInteger,
  commandId: z.string().min(1).max(128),
});

export type StudioBodyParagraphTargetV1 = z.infer<typeof studioBodyParagraphTargetSchema>;
export type StudioDocumentStateV1 = z.infer<typeof studioDocumentStateSchema>;
export type StudioSelectionContextV1 = z.infer<typeof studioSelectionContextSchema>;
export type StudioApplyTextCommandV1 = z.infer<typeof studioApplyTextCommandSchema>;
export type StudioRevertTextCommandV1 = z.infer<typeof studioRevertTextCommandSchema>;
export type StudioTextCommandReceiptV1 = z.infer<typeof studioTextCommandReceiptSchema>;
export type StudioFocusTargetResultV1 = z.infer<typeof studioFocusTargetResultSchema>;
export type StudioDocumentChangedEventV1 = z.infer<typeof studioDocumentChangedEventSchema>;

export interface StudioDocumentAgentProtocol {
  getDocumentState(): Promise<StudioDocumentStateV1>;
  getSelectionContext(): Promise<StudioSelectionContextV1>;
  applyTextCommand(command: StudioApplyTextCommandV1): Promise<StudioTextCommandReceiptV1>;
  revertTextCommand(command: StudioRevertTextCommandV1): Promise<StudioTextCommandReceiptV1>;
  focusTarget(target: StudioBodyParagraphTargetV1): Promise<StudioFocusTargetResultV1>;
  onDocumentChanged(listener: (event: StudioDocumentChangedEventV1) => void): () => void;
}

type UnknownMethod = (...args: unknown[]) => unknown;

/** 공개 SDK 메서드가 모두 있을 때만 native command adapter를 노출한다. */
export function resolveStudioDocumentAgentProtocol(editor: unknown): StudioDocumentAgentProtocol | null {
  if (!editor || typeof editor !== "object") return null;
  const record = editor as Record<string, unknown>;
  const required = [
    "getDocumentState",
    "getSelectionContext",
    "applyTextCommand",
    "revertTextCommand",
    "focusTarget",
    "onDocumentChanged",
  ] as const;
  if (required.some((name) => typeof record[name] !== "function")) return null;

  const invoke = (name: typeof required[number], ...args: unknown[]): unknown => (
    (record[name] as UnknownMethod).call(editor, ...args)
  );
  return {
    getDocumentState: async () => studioDocumentStateSchema.parse(await invoke("getDocumentState")),
    getSelectionContext: async () => studioSelectionContextSchema.parse(await invoke("getSelectionContext")),
    applyTextCommand: async (command) => studioTextCommandReceiptSchema.parse(
      await invoke("applyTextCommand", studioApplyTextCommandSchema.parse(command)),
    ),
    revertTextCommand: async (command) => studioTextCommandReceiptSchema.parse(
      await invoke("revertTextCommand", studioRevertTextCommandSchema.parse(command)),
    ),
    focusTarget: async (target) => studioFocusTargetResultSchema.parse(
      await invoke("focusTarget", studioBodyParagraphTargetSchema.parse(target)),
    ),
    onDocumentChanged: (listener) => {
      const unsubscribe = invoke("onDocumentChanged", (event: unknown) => {
        listener(studioDocumentChangedEventSchema.parse(event));
      });
      if (typeof unsubscribe !== "function") {
        throw new Error("RHWP Studio documentChanged 구독 해제 함수가 없습니다.");
      }
      return unsubscribe as () => void;
    },
  };
}

export interface StudioDocumentAgentEvidenceDocument {
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getTextRange(section: number, paragraph: number, charOffset: number, count: number): string;
  getControlTextPositions(section: number, paragraph: number): string;
  getCharPropertiesAt(section: number, paragraph: number, charOffset: number): string;
  getParaPropertiesAt(section: number, paragraph: number): string;
  getStyleAt(section: number, paragraph: number): string;
}

/** Studio controller와 byte-for-byte 같은 JSON projection으로 command evidence를 만든다. */
export async function buildStudioDocumentAgentCommandEvidence(input: {
  document: StudioDocumentAgentEvidenceDocument;
  target: DocumentEditAnchor;
  formatSnapshot: DocumentAgentFormatSnapshot;
}): Promise<StudioDocumentAgentCommandEvidence> {
  const previous = input.target.paragraph > 0
    ? await studioParagraphSemantic(input.document, input.target.section, input.target.paragraph - 1)
    : null;
  const next = input.target.paragraph + 1 < input.document.getParagraphCount(input.target.section)
    ? await studioParagraphSemantic(input.document, input.target.section, input.target.paragraph + 1)
    : null;
  const [formatSha256, adjacentContextSha256] = await Promise.all([
    studioDocumentAgentFormatSha256(input.formatSnapshot),
    sha256Hex(JSON.stringify({ schemaVersion: 1, previous, next })),
  ]);
  return { formatSha256, adjacentContextSha256 };
}

async function studioParagraphSemantic(
  document: StudioDocumentAgentEvidenceDocument,
  section: number,
  paragraph: number,
): Promise<Record<string, unknown>> {
  const length = document.getParagraphLength(section, paragraph);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("RHWP Studio adjacent 문단 길이가 유효하지 않습니다.");
  }
  const text = length > 0 ? document.getTextRange(section, paragraph, 0, length) : "";
  const charShapeIds: number[] = [];
  for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
    charShapeIds.push(readNonnegativeSafeId(
      document.getCharPropertiesAt(section, paragraph, offset),
      "charShapeId",
    ));
  }
  return {
    section,
    paragraph,
    length,
    textSha256: await sha256Hex(text),
    paraShapeId: readNonnegativeSafeId(document.getParaPropertiesAt(section, paragraph), "paraShapeId"),
    styleId: readNonnegativeSafeId(document.getStyleAt(section, paragraph), "id"),
    charShapeIds,
    controls: readNonnegativeSafeIntegerArray(document.getControlTextPositions(section, paragraph)),
  };
}

function readNonnegativeSafeId(value: string, property: string): number {
  const parsed = readJsonObject(value, property);
  const id = parsed[property];
  if (!Number.isSafeInteger(id) || (id as number) < 0) {
    throw new Error(`RHWP Studio ${property}가 nonnegative safe integer가 아닙니다.`);
  }
  return id as number;
}

function readJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`RHWP Studio ${label} JSON을 해석하지 못했습니다.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`RHWP Studio ${label}가 객체가 아닙니다.`);
  }
  return parsed as Record<string, unknown>;
}

function readNonnegativeSafeIntegerArray(value: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("RHWP Studio control positions JSON을 해석하지 못했습니다.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("RHWP Studio control positions가 nonnegative safe integer array가 아닙니다.");
  }
  return parsed as number[];
}
