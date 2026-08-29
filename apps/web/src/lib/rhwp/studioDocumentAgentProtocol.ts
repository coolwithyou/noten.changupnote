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

export const studioTableCellTextTargetSchema = z.strictObject({
  kind: z.literal("table_cell_text"),
  section: nonnegativeSafeInteger,
  parentPara: nonnegativeSafeInteger,
  controlIndex: nonnegativeSafeInteger,
  cellIndex: nonnegativeSafeInteger,
  cellParagraph: nonnegativeSafeInteger,
});

export const studioTableCellRegionTargetSchema = z.strictObject({
  kind: z.literal("table_cell_region"),
  section: nonnegativeSafeInteger,
  parentPara: nonnegativeSafeInteger,
  controlIndex: nonnegativeSafeInteger,
  cellIndex: nonnegativeSafeInteger,
});

export const studioFormTextTargetSchema = z.strictObject({
  kind: z.literal("form_text"),
  section: nonnegativeSafeInteger,
  paragraph: nonnegativeSafeInteger,
  fieldId: nonnegativeSafeInteger,
});

/** 서버 field map이 한 문단 안의 값 범위를 결속할 때 쓰는 host 전용 target. */
export const studioParagraphFieldTargetSchema = z.strictObject({
  kind: z.literal("body_paragraph_text"),
  section: nonnegativeSafeInteger,
  paragraph: nonnegativeSafeInteger,
  length: positiveSafeInteger.max(4_000),
  valueStart: nonnegativeSafeInteger.max(4_000),
  valueEnd: nonnegativeSafeInteger.max(4_000),
}).superRefine((target, context) => {
  if (target.valueStart > target.valueEnd || target.valueEnd > target.length) {
    context.addIssue({ code: "custom", message: "paragraph field 값 범위가 문단 길이를 벗어났습니다." });
  }
});

export const studioFieldTargetSchema = z.discriminatedUnion("kind", [
  studioTableCellTextTargetSchema,
  studioTableCellRegionTargetSchema,
  studioFormTextTargetSchema,
]);

export const studioFieldBindingTargetSchema = z.discriminatedUnion("kind", [
  studioTableCellTextTargetSchema,
  studioTableCellRegionTargetSchema,
  studioFormTextTargetSchema,
  studioParagraphFieldTargetSchema,
]);

const studioRestoreCharShapeIdsSchema = z.array(nonnegativeSafeInteger).min(1).max(4_000);

export const studioFieldRestoreFormatSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("table_cell_text"),
    charShapeIds: studioRestoreCharShapeIdsSchema,
    paraShapeId: nonnegativeSafeInteger,
  }),
  z.strictObject({
    kind: z.literal("table_cell_region"),
    paragraphs: z.array(z.strictObject({
      length: nonnegativeSafeInteger.max(4_000),
      charShapeIds: studioRestoreCharShapeIdsSchema,
      paraShapeId: nonnegativeSafeInteger,
    })).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("form_text"),
    charShapeIds: studioRestoreCharShapeIdsSchema,
    paraShapeId: nonnegativeSafeInteger,
    styleId: nonnegativeSafeInteger,
  }),
]);

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

export const studioFieldSelectionContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentEpoch: positiveSafeInteger,
  changeSeq: nonnegativeSafeInteger,
  page: positiveSafeInteger,
  editable: z.boolean(),
  target: studioFieldTargetSchema.nullable(),
}).superRefine((selection, context) => {
  if (selection.target === null && selection.editable) {
    context.addIssue({ code: "custom", message: "target이 없는 field selection은 editable일 수 없습니다." });
  }
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

export const studioApplyFieldCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1).max(128),
  expectedDocumentEpoch: positiveSafeInteger,
  expectedChangeSeq: nonnegativeSafeInteger,
  expectedDocumentSha256: sha256Schema,
  target: studioFieldTargetSchema,
  expectedBeforeSha256: sha256Schema,
  expectedFormatSha256: sha256Schema,
  expectedAdjacentContextSha256: sha256Schema,
  replacement: z.string().max(4_000),
  replacementStyle: z.enum(["actual-input", "preserve", "restore-exact"]).optional(),
  replacementFormat: studioFieldRestoreFormatSchema.optional(),
  expectedReplacementFormatSha256: sha256Schema.optional(),
}).superRefine((command, context) => {
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(command.replacement)) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "field replacement에 control 문자를 넣을 수 없습니다." });
  }
  if (command.target.kind !== "table_cell_region" && /\n/u.test(command.replacement)) {
    context.addIssue({ code: "custom", path: ["replacement"], message: "atomic field replacement에는 줄바꿈을 넣을 수 없습니다." });
  }
  if (command.replacementStyle === "restore-exact") {
    if (!command.replacementFormat || !command.expectedReplacementFormatSha256) {
      context.addIssue({ code: "custom", path: ["replacementFormat"], message: "exact 복원 서식이 필요합니다." });
      return;
    }
    if (command.replacementFormat.kind !== command.target.kind) {
      context.addIssue({ code: "custom", path: ["replacementFormat", "kind"], message: "target kind와 같아야 합니다." });
      return;
    }
    const lengths = command.target.kind === "table_cell_region"
      ? command.replacement.split("\n").map(part => Array.from(part).length)
      : [Array.from(command.replacement).length];
    const formats = command.replacementFormat.kind === "table_cell_region"
      ? command.replacementFormat.paragraphs
      : [{ length: lengths[0]!, charShapeIds: command.replacementFormat.charShapeIds }];
    if (formats.length !== lengths.length || formats.some((format, index) =>
      format.length !== lengths[index]
      || format.charShapeIds.length !== Math.max(lengths[index]!, 1))) {
      context.addIssue({ code: "custom", path: ["replacementFormat"], message: "replacement 길이와 같아야 합니다." });
    }
  } else if (command.replacementFormat || command.expectedReplacementFormatSha256) {
    context.addIssue({ code: "custom", path: ["replacementFormat"], message: "restore-exact 명령에서만 사용할 수 있습니다." });
  }
});

export const studioRevertFieldCommandSchema = studioRevertTextCommandSchema;

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

export const studioFieldCommandReceiptSchema = z.strictObject({
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
  target: studioFieldTargetSchema,
}).superRefine((receipt, context) => {
  if (receipt.afterChangeSeq !== receipt.beforeChangeSeq + 1) {
    context.addIssue({ code: "custom", message: "field receipt change sequence가 연속되지 않습니다." });
  }
});

export const studioFocusTargetResultSchema = z.strictObject({
  focused: z.boolean(),
  page: positiveSafeInteger,
});

export const studioDocumentChangedEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reason: z.enum(["agent_apply", "agent_revert", "field_agent_apply", "field_agent_revert"]),
  documentEpoch: positiveSafeInteger,
  changeSeq: positiveSafeInteger,
  commandId: z.string().min(1).max(128),
});

export type StudioBodyParagraphTargetV1 = z.infer<typeof studioBodyParagraphTargetSchema>;
export type StudioTableCellTextTargetV1 = z.infer<typeof studioTableCellTextTargetSchema>;
export type StudioTableCellRegionTargetV1 = z.infer<typeof studioTableCellRegionTargetSchema>;
export type StudioFormTextTargetV1 = z.infer<typeof studioFormTextTargetSchema>;
export type StudioParagraphFieldTargetV1 = z.infer<typeof studioParagraphFieldTargetSchema>;
export type StudioFieldTargetV1 = z.infer<typeof studioFieldTargetSchema>;
export type StudioFieldBindingTargetV1 = z.infer<typeof studioFieldBindingTargetSchema>;
export type StudioFieldRestoreFormatV1 = z.infer<typeof studioFieldRestoreFormatSchema>;
export type StudioDocumentStateV1 = z.infer<typeof studioDocumentStateSchema>;
export type StudioSelectionContextV1 = z.infer<typeof studioSelectionContextSchema>;
export type StudioFieldSelectionContextV1 = z.infer<typeof studioFieldSelectionContextSchema>;
export type StudioApplyTextCommandV1 = z.infer<typeof studioApplyTextCommandSchema>;
export type StudioRevertTextCommandV1 = z.infer<typeof studioRevertTextCommandSchema>;
export type StudioApplyFieldCommandV1 = z.infer<typeof studioApplyFieldCommandSchema>;
export type StudioRevertFieldCommandV1 = z.infer<typeof studioRevertFieldCommandSchema>;
export type StudioTextCommandReceiptV1 = z.infer<typeof studioTextCommandReceiptSchema>;
export type StudioFieldCommandReceiptV1 = z.infer<typeof studioFieldCommandReceiptSchema>;
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

export interface StudioFieldNavigationProtocol {
  focusFieldTarget(target: StudioFieldTargetV1): Promise<StudioFocusTargetResultV1>;
}

export interface StudioFieldSelectionProtocol {
  getFieldSelectionContext(): Promise<StudioFieldSelectionContextV1>;
  onFieldSelectionChanged(listener: (event: StudioFieldSelectionContextV1) => void): () => void;
}

export interface StudioFieldAgentProtocol extends StudioFieldNavigationProtocol {
  getDocumentState(): Promise<StudioDocumentStateV1>;
  applyFieldCommand(command: StudioApplyFieldCommandV1): Promise<StudioFieldCommandReceiptV1>;
  revertFieldCommand(command: StudioRevertFieldCommandV1): Promise<StudioFieldCommandReceiptV1>;
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

/** 일반 문단 agent capability와 독립적으로 exact field 탐색 capability만 연다. */
export function resolveStudioFieldNavigationProtocol(editor: unknown): StudioFieldNavigationProtocol | null {
  if (!editor || typeof editor !== "object") return null;
  const method = (editor as Record<string, unknown>).focusFieldTarget;
  if (typeof method !== "function") return null;
  return {
    focusFieldTarget: async (target) => studioFocusTargetResultSchema.parse(
      await (method as UnknownMethod).call(editor, studioFieldTargetSchema.parse(target)),
    ),
  };
}

/** Studio의 현재 셀 선택을 호스트 필드 선택으로 동기화하는 read-only capability. */
export function resolveStudioFieldSelectionProtocol(editor: unknown): StudioFieldSelectionProtocol | null {
  if (!editor || typeof editor !== "object") return null;
  const record = editor as Record<string, unknown>;
  if (
    typeof record.getFieldSelectionContext !== "function"
    || typeof record.onFieldSelectionChanged !== "function"
  ) return null;
  return {
    getFieldSelectionContext: async () => studioFieldSelectionContextSchema.parse(
      await (record.getFieldSelectionContext as UnknownMethod).call(editor),
    ),
    onFieldSelectionChanged: (listener) => {
      const unsubscribe = (record.onFieldSelectionChanged as UnknownMethod).call(
        editor,
        (event: unknown) => listener(studioFieldSelectionContextSchema.parse(event)),
      );
      if (typeof unsubscribe !== "function") {
        throw new Error("RHWP Studio fieldSelectionChanged 구독 해제 함수가 없습니다.");
      }
      return unsubscribe as () => void;
    },
  };
}

/** field apply/revert 전체 capability가 있을 때만 mutation adapter를 노출한다. */
export function resolveStudioFieldAgentProtocol(editor: unknown): StudioFieldAgentProtocol | null {
  if (!editor || typeof editor !== "object") return null;
  const record = editor as Record<string, unknown>;
  const required = [
    "getDocumentState",
    "focusFieldTarget",
    "applyFieldCommand",
    "revertFieldCommand",
    "onDocumentChanged",
  ] as const;
  if (required.some((name) => typeof record[name] !== "function")) return null;
  const invoke = (name: typeof required[number], ...args: unknown[]): unknown => (
    (record[name] as UnknownMethod).call(editor, ...args)
  );
  return {
    getDocumentState: async () => studioDocumentStateSchema.parse(await invoke("getDocumentState")),
    focusFieldTarget: async (target) => studioFocusTargetResultSchema.parse(
      await invoke("focusFieldTarget", studioFieldTargetSchema.parse(target)),
    ),
    applyFieldCommand: async (command) => studioFieldCommandReceiptSchema.parse(
      await invoke("applyFieldCommand", studioApplyFieldCommandSchema.parse(command)),
    ),
    revertFieldCommand: async (command) => studioFieldCommandReceiptSchema.parse(
      await invoke("revertFieldCommand", studioRevertFieldCommandSchema.parse(command)),
    ),
    onDocumentChanged: (listener) => {
      const unsubscribe = invoke("onDocumentChanged", (event: unknown) => {
        listener(studioDocumentChangedEventSchema.parse(event));
      });
      if (typeof unsubscribe !== "function") {
        throw new Error("RHWP Studio field documentChanged 구독 해제 함수가 없습니다.");
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
