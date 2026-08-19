import type { RhwpModule, RhwpDocumentFormat } from "./client";
import { sha256Hex } from "./documentAgentContract";
import {
  studioApplyFieldCommandSchema,
  studioRevertFieldCommandSchema,
  type StudioFieldAgentProtocol,
  type StudioFieldCommandReceiptV1,
  type StudioTableCellTextTargetV1,
} from "./studioDocumentAgentProtocol";

export interface FieldCommandBindingV1 {
  target: StudioTableCellTextTargetV1;
  beforeText: string;
  beforeTextSha256: string;
  formatSha256: string;
  adjacentContextSha256: string;
}

export interface StudioFieldCommandResult {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  beforeDocumentSha256: string;
  afterDocumentSha256: string;
  receipt: StudioFieldCommandReceiptV1;
}

export interface StudioFieldAgentTransaction {
  apply(input: {
    bytes: Uint8Array;
    format: RhwpDocumentFormat;
    commandId: string;
    binding: FieldCommandBindingV1;
    replacement: string;
  }): Promise<StudioFieldCommandResult>;
  revert(input: {
    bytes: Uint8Array;
    format: RhwpDocumentFormat;
    commandId: string;
    expectedAfterTextSha256: string;
    recovery?: {
      appliedDocumentSha256: string;
      appliedText: string;
      binding: FieldCommandBindingV1;
    };
  }): Promise<StudioFieldCommandResult>;
}

export class StudioFieldAgentMutationVerificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StudioFieldAgentMutationVerificationError";
  }
}

interface AppliedEntry {
  commandId: string;
  binding: FieldCommandBindingV1;
  replacement: string;
  receipt: StudioFieldCommandReceiptV1;
  status: "applied" | "reverted";
}

/**
 * UI는 field command 순서를 조립하지 않는다. 이 module이 Studio fence, native mutation,
 * export/reopen, exact cell postimage 검증과 최근 command journal을 한 interface 뒤에 숨긴다.
 */
export function createStudioFieldAgentTransaction(input: {
  rhwp: RhwpModule;
  protocol: StudioFieldAgentProtocol;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
}): StudioFieldAgentTransaction {
  let latest: AppliedEntry | null = null;
  return {
    async apply(commandInput) {
      const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
      const beforeEvidence = await collectStudioFieldEvidence(
        input.rhwp,
        commandInput.bytes,
        commandInput.binding.target,
      );
      assertBinding(commandInput.binding, beforeEvidence);
      const state = await input.protocol.getDocumentState();
      if (state.format !== commandInput.format || state.documentSha256 !== beforeDocumentSha256) {
        throw new Error("Studio field command 기준 문서가 현재 검증 바이트와 다릅니다.");
      }
      const command = studioApplyFieldCommandSchema.parse({
        schemaVersion: 1,
        commandId: commandInput.commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedDocumentSha256: state.documentSha256,
        target: commandInput.binding.target,
        expectedBeforeSha256: commandInput.binding.beforeTextSha256,
        expectedFormatSha256: commandInput.binding.formatSha256,
        expectedAdjacentContextSha256: commandInput.binding.adjacentContextSha256,
        replacement: commandInput.replacement,
      });
      let receipt: StudioFieldCommandReceiptV1;
      try {
        receipt = await input.protocol.applyFieldCommand(command);
        assertApplyReceipt(receipt, commandInput, state);
      } catch (error) {
        throw new StudioFieldAgentMutationVerificationError(
          "Studio 필드 명령 결과를 안전하게 확인하지 못했습니다.",
          error,
        );
      }
      let result: StudioFieldCommandResult;
      try {
        result = await verifyCommittedFieldMutation({
          ...input,
          format: commandInput.format,
          target: commandInput.binding.target,
          expectedText: commandInput.replacement,
          expectedFormatSha256: commandInput.binding.formatSha256,
          expectedAdjacentContextSha256: commandInput.binding.adjacentContextSha256,
          receipt,
          beforeDocumentSha256,
        });
      } catch (error) {
        throw new StudioFieldAgentMutationVerificationError(
          "Studio 필드 적용 뒤 export 검증에 실패했습니다.",
          error,
        );
      }
      latest = {
        commandId: commandInput.commandId,
        binding: commandInput.binding,
        replacement: commandInput.replacement,
        receipt,
        status: "applied",
      };
      return result;
    },

    async revert(commandInput) {
      const entry = latest;
      if (!entry || entry.status !== "applied" || entry.commandId !== commandInput.commandId) {
        const recovery = commandInput.recovery;
        if (!recovery) throw new Error("현재 Studio 세션의 가장 최근 필드 적용만 되돌릴 수 있습니다.");
        const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
        if (
          beforeDocumentSha256 !== recovery.appliedDocumentSha256
          || await sha256Hex(recovery.appliedText) !== commandInput.expectedAfterTextSha256
        ) throw new Error("저장된 필드 적용 revision과 현재 Studio 문서가 달라 Undo를 차단했습니다.");
        const appliedBinding: FieldCommandBindingV1 = {
          ...recovery.binding,
          beforeText: recovery.appliedText,
          beforeTextSha256: commandInput.expectedAfterTextSha256,
        };
        const beforeEvidence = await collectStudioFieldEvidence(
          input.rhwp,
          commandInput.bytes,
          appliedBinding.target,
        );
        assertBinding(appliedBinding, beforeEvidence);
        const state = await input.protocol.getDocumentState();
        if (state.format !== commandInput.format || state.documentSha256 !== beforeDocumentSha256) {
          throw new Error("Studio field Undo 기준 문서가 현재 검증 바이트와 다릅니다.");
        }
        const recoveryInput = {
          commandId: `${commandInput.commandId}:undo`,
          binding: appliedBinding,
          replacement: recovery.binding.beforeText,
        };
        const command = studioApplyFieldCommandSchema.parse({
          schemaVersion: 1,
          commandId: recoveryInput.commandId,
          expectedDocumentEpoch: state.documentEpoch,
          expectedChangeSeq: state.changeSeq,
          expectedDocumentSha256: state.documentSha256,
          target: appliedBinding.target,
          expectedBeforeSha256: appliedBinding.beforeTextSha256,
          expectedFormatSha256: appliedBinding.formatSha256,
          expectedAdjacentContextSha256: appliedBinding.adjacentContextSha256,
          replacement: recovery.binding.beforeText,
        });
        let receipt: StudioFieldCommandReceiptV1;
        try {
          receipt = await input.protocol.applyFieldCommand(command);
          assertApplyReceipt(receipt, recoveryInput, state);
          return await verifyCommittedFieldMutation({
            ...input,
            format: commandInput.format,
            target: recovery.binding.target,
            expectedText: recovery.binding.beforeText,
            expectedFormatSha256: recovery.binding.formatSha256,
            expectedAdjacentContextSha256: recovery.binding.adjacentContextSha256,
            receipt,
            beforeDocumentSha256,
          });
        } catch (error) {
          throw new StudioFieldAgentMutationVerificationError(
            "새 Studio 세션에서 저장된 필드 적용을 되돌린 결과를 확인하지 못했습니다.",
            error,
          );
        }
      }
      const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
      const state = await input.protocol.getDocumentState();
      if (
        state.format !== commandInput.format
        || state.documentSha256 !== beforeDocumentSha256
        || state.documentEpoch !== entry.receipt.documentEpoch
        || state.changeSeq !== entry.receipt.afterChangeSeq
        || state.documentSha256 !== entry.receipt.afterDocumentSha256
      ) {
        throw new Error("필드 적용 뒤 Studio 문서가 변경되어 자동 Undo를 차단했습니다.");
      }
      const command = studioRevertFieldCommandSchema.parse({
        schemaVersion: 1,
        commandId: commandInput.commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedAfterDocumentSha256: state.documentSha256,
        expectedAfterSha256: commandInput.expectedAfterTextSha256,
      });
      const receipt = await input.protocol.revertFieldCommand(command);
      if (
        receipt.operation !== "revert"
        || receipt.commandId !== commandInput.commandId
        || receipt.beforeDocumentSha256 !== state.documentSha256
        || receipt.afterTextSha256 !== entry.binding.beforeTextSha256
        || receipt.formatSha256 !== entry.binding.formatSha256
        || receipt.adjacentContextSha256 !== entry.binding.adjacentContextSha256
        || !sameTarget(receipt.target, entry.binding.target)
      ) throw new Error("Studio field revert receipt가 승인된 binding과 다릅니다.");
      const result = await verifyCommittedFieldMutation({
        ...input,
        format: commandInput.format,
        target: entry.binding.target,
        expectedText: entry.binding.beforeText,
        expectedFormatSha256: entry.binding.formatSha256,
        expectedAdjacentContextSha256: entry.binding.adjacentContextSha256,
        receipt,
        beforeDocumentSha256,
      });
      entry.status = "reverted";
      return result;
    },
  };
}

async function verifyCommittedFieldMutation(input: {
  rhwp: RhwpModule;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
  format: RhwpDocumentFormat;
  target: StudioTableCellTextTargetV1;
  expectedText: string;
  expectedFormatSha256: string;
  expectedAdjacentContextSha256: string;
  receipt: StudioFieldCommandReceiptV1;
  beforeDocumentSha256: string;
}): Promise<StudioFieldCommandResult> {
  const bytes = await input.exportCurrentBytes(input.format);
  const afterDocumentSha256 = await sha256Hex(bytes);
  if (afterDocumentSha256 !== input.receipt.afterDocumentSha256) {
    throw new Error("Studio field receipt와 검증 export의 문서 SHA가 다릅니다.");
  }
  const evidence = await collectStudioFieldEvidence(input.rhwp, bytes, input.target);
  if (
    evidence.text !== input.expectedText
    || evidence.textSha256 !== input.receipt.afterTextSha256
    || evidence.formatSha256 !== input.expectedFormatSha256
    || evidence.adjacentContextSha256 !== input.expectedAdjacentContextSha256
  ) throw new Error("Studio field export/reopen postcondition이 승인된 값과 다릅니다.");
  return {
    bytes,
    format: input.format,
    beforeDocumentSha256: input.beforeDocumentSha256,
    afterDocumentSha256,
    receipt: input.receipt,
  };
}

interface FieldEvidence {
  text: string;
  textSha256: string;
  formatSha256: string;
  adjacentContextSha256: string;
}

export async function collectStudioFieldEvidence(
  rhwp: RhwpModule,
  bytes: Uint8Array,
  target: StudioTableCellTextTargetV1,
): Promise<FieldEvidence> {
  const document = new rhwp.HwpDocument(bytes);
  try {
    const dimensions = JSON.parse(document.getTableDimensions(
      target.section,
      target.parentPara,
      target.controlIndex,
    )) as { rowCount: number; colCount: number; cellCount: number };
    if (!Number.isSafeInteger(dimensions.cellCount) || target.cellIndex >= dimensions.cellCount) {
      throw new Error("exact field table cell을 찾지 못했습니다.");
    }
    const length = document.getCellParagraphLength(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
    );
    const text = length > 0 ? document.getTextInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
      0,
      length,
    ) : "";
    const charShapeIds: number[] = [];
    for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
      charShapeIds.push(readId(document.getCellCharPropertiesAt(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.cellIndex,
        target.cellParagraph,
        offset,
      ), "charShapeId"));
    }
    const paraShapeId = readId(document.getCellParaPropertiesAt(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
    ), "paraShapeId");
    const cellProperties = JSON.parse(document.getCellOwnProperties(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
    )) as unknown;
    const charShapeId = charShapeIds[0];
    const charShape = charShapeIds.every((id) => id === charShapeId)
      ? { kind: "uniform", id: charShapeId }
      : { kind: "runs", ids: charShapeIds };
    return {
      text,
      textSha256: await sha256Hex(text),
      formatSha256: await sha256Hex(stableJson({
        schemaVersion: 1,
        charShape,
        paraShapeId,
        cellProperties,
      })),
      adjacentContextSha256: await fieldNonTargetManifest(document, target, dimensions),
    };
  } finally {
    document.free();
  }
}

async function fieldNonTargetManifest(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioTableCellTextTargetV1,
  dimensions: { rowCount: number; colCount: number; cellCount: number },
): Promise<string> {
  const cells: Array<Record<string, unknown>> = [];
  for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
    const paragraphCount = document.getCellParagraphCount(
      target.section,
      target.parentPara,
      target.controlIndex,
      cellIndex,
    );
    const paragraphs: Array<Record<string, unknown>> = [];
    for (let cellParagraph = 0; cellParagraph < paragraphCount; cellParagraph += 1) {
      if (cellIndex === target.cellIndex && cellParagraph === target.cellParagraph) continue;
      const length = document.getCellParagraphLength(
        target.section,
        target.parentPara,
        target.controlIndex,
        cellIndex,
        cellParagraph,
      );
      const text = length > 0 ? document.getTextInCell(
        target.section,
        target.parentPara,
        target.controlIndex,
        cellIndex,
        cellParagraph,
        0,
        length,
      ) : "";
      const charShapeIds: number[] = [];
      for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
        charShapeIds.push(readId(document.getCellCharPropertiesAt(
          target.section,
          target.parentPara,
          target.controlIndex,
          cellIndex,
          cellParagraph,
          offset,
        ), "charShapeId"));
      }
      paragraphs.push({
        cellIndex,
        cellParagraph,
        length,
        textSha256: await sha256Hex(text),
        paraShapeId: readId(document.getCellParaPropertiesAt(
          target.section,
          target.parentPara,
          target.controlIndex,
          cellIndex,
          cellParagraph,
        ), "paraShapeId"),
        charShapeIds,
      });
    }
    cells.push({
      cellIndex,
      properties: JSON.parse(document.getCellOwnProperties(
        target.section,
        target.parentPara,
        target.controlIndex,
        cellIndex,
      )) as unknown,
      paragraphCount,
      paragraphs,
    });
  }
  return sha256Hex(stableJson({
    schemaVersion: 1,
    table: {
      section: target.section,
      parentPara: target.parentPara,
      controlIndex: target.controlIndex,
      dimensions,
      cells,
    },
  }));
}

function readId(value: string, key: string): number {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const id = parsed[key];
  if (!Number.isSafeInteger(id) || (id as number) < 0) throw new Error(`${key}가 올바르지 않습니다.`);
  return id as number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertBinding(binding: FieldCommandBindingV1, evidence: FieldEvidence): void {
  if (
    evidence.text !== binding.beforeText
    || evidence.textSha256 !== binding.beforeTextSha256
    || evidence.formatSha256 !== binding.formatSha256
    || evidence.adjacentContextSha256 !== binding.adjacentContextSha256
  ) throw new Error("서버 field binding이 현재 Studio revision과 다릅니다.");
}

function assertApplyReceipt(
  receipt: StudioFieldCommandReceiptV1,
  input: { commandId: string; binding: FieldCommandBindingV1; replacement: string },
  state: { documentEpoch: number; changeSeq: number; documentSha256: string; pageCount: number },
): void {
  if (
    receipt.operation !== "apply"
    || receipt.commandId !== input.commandId
    || receipt.documentEpoch !== state.documentEpoch
    || receipt.beforeChangeSeq !== state.changeSeq
    || receipt.beforeDocumentSha256 !== state.documentSha256
    || receipt.beforeTextSha256 !== input.binding.beforeTextSha256
    || receipt.formatSha256 !== input.binding.formatSha256
    || receipt.adjacentContextSha256 !== input.binding.adjacentContextSha256
    || receipt.pageCountBefore !== state.pageCount
    || receipt.pageCountAfter !== state.pageCount
    || !sameTarget(receipt.target, input.binding.target)
  ) throw new Error("Studio field apply receipt가 승인된 exact binding과 다릅니다.");
}

function sameTarget(left: StudioTableCellTextTargetV1, right: StudioTableCellTextTargetV1): boolean {
  return left.kind === right.kind
    && left.section === right.section
    && left.parentPara === right.parentPara
    && left.controlIndex === right.controlIndex
    && left.cellIndex === right.cellIndex
    && left.cellParagraph === right.cellParagraph;
}
