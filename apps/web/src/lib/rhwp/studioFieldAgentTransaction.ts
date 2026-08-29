import type { RhwpModule, RhwpDocumentFormat } from "./client";
import { canonicalJson, sha256Hex } from "./documentAgentContract";
import {
  buildStudioDocumentAgentCommandEvidence,
  studioApplyTextCommandSchema,
  studioApplyFieldCommandSchema,
  studioRevertTextCommandSchema,
  studioRevertFieldCommandSchema,
  type StudioDocumentAgentProtocol,
  type StudioFieldBindingTargetV1,
  type StudioFieldAgentProtocol,
  type StudioFieldCommandReceiptV1,
  type StudioFieldRestoreFormatV1,
  type StudioFieldTargetV1,
  type StudioFormTextTargetV1,
  type StudioParagraphFieldTargetV1,
  type StudioTableCellRegionTargetV1,
  type StudioTableCellTextTargetV1,
  type StudioTextCommandReceiptV1,
} from "./studioDocumentAgentProtocol";
import {
  studioBodyParagraphTargetForField,
} from "./studioParagraphFieldBindings";

export interface FieldCommandBindingV1 {
  target: StudioFieldBindingTargetV1;
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
  receipt: StudioFieldCommandReceiptV1 | StudioTextCommandReceiptV1;
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
      restoreFormat?: StudioFieldRestoreFormatV1;
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
  binding: NativeFieldBindingV1;
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
  /** protocol은 기존 native table/form caller 호환용이다. */
  protocol?: StudioFieldAgentProtocol;
  fieldProtocol?: StudioFieldAgentProtocol | null;
  documentProtocol?: StudioDocumentAgentProtocol | null;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
}): StudioFieldAgentTransaction {
  const fieldProtocol = input.fieldProtocol ?? input.protocol ?? null;
  const documentProtocol = input.documentProtocol ?? null;
  const native = fieldProtocol
    ? createNativeStudioFieldAgentTransaction({
        rhwp: input.rhwp,
        protocol: fieldProtocol,
        exportCurrentBytes: input.exportCurrentBytes,
      })
    : null;
  const paragraph = documentProtocol
    ? createStudioParagraphFieldAgentTransaction({
        rhwp: input.rhwp,
        protocol: documentProtocol,
        exportCurrentBytes: input.exportCurrentBytes,
      })
    : null;
  let latest: { commandId: string; kind: "native" | "paragraph" } | null = null;
  return {
    async apply(commandInput) {
      if (commandInput.binding.target.kind === "body_paragraph_text") {
        if (!paragraph) throw new Error("Studio body paragraph field capability가 없습니다.");
        const result = await paragraph.apply(commandInput as ParagraphFieldApplyInput);
        latest = { commandId: commandInput.commandId, kind: "paragraph" };
        return result;
      }
      if (!native) throw new Error("Studio native field capability가 없습니다.");
      const result = await native.apply(commandInput as NativeFieldApplyInput);
      latest = { commandId: commandInput.commandId, kind: "native" };
      return result;
    },
    async revert(commandInput) {
      const recoveryKind = commandInput.recovery?.binding.target.kind === "body_paragraph_text"
        ? "paragraph"
        : commandInput.recovery
          ? "native"
          : latest?.commandId === commandInput.commandId
            ? latest.kind
            : null;
      if (recoveryKind === "paragraph") {
        if (!paragraph) throw new Error("Studio body paragraph field capability가 없습니다.");
        return paragraph.revert(commandInput as ParagraphFieldRevertInput);
      }
      if (recoveryKind === "native") {
        if (!native) throw new Error("Studio native field capability가 없습니다.");
        return native.revert(commandInput as NativeFieldRevertInput);
      }
      throw new Error("현재 Studio 세션의 가장 최근 필드 적용만 되돌릴 수 있습니다.");
    },
  };
}

type NativeFieldBindingV1 = Omit<FieldCommandBindingV1, "target"> & { target: StudioFieldTargetV1 };
type ParagraphFieldBindingV1 = Omit<FieldCommandBindingV1, "target"> & { target: StudioParagraphFieldTargetV1 };
type NativeFieldApplyInput = Parameters<StudioFieldAgentTransaction["apply"]>[0] & { binding: NativeFieldBindingV1 };
type NativeFieldRevertInput = Parameters<StudioFieldAgentTransaction["revert"]>[0] & {
  recovery?: NonNullable<Parameters<StudioFieldAgentTransaction["revert"]>[0]["recovery"]> & { binding: NativeFieldBindingV1 };
};
type ParagraphFieldApplyInput = Parameters<StudioFieldAgentTransaction["apply"]>[0] & { binding: ParagraphFieldBindingV1 };
type ParagraphFieldRevertInput = Parameters<StudioFieldAgentTransaction["revert"]>[0] & {
  recovery?: NonNullable<Parameters<StudioFieldAgentTransaction["revert"]>[0]["recovery"]> & { binding: ParagraphFieldBindingV1 };
};

interface NativeStudioFieldAgentTransaction {
  apply(input: NativeFieldApplyInput): Promise<StudioFieldCommandResult>;
  revert(input: NativeFieldRevertInput): Promise<StudioFieldCommandResult>;
}

function createNativeStudioFieldAgentTransaction(input: {
  rhwp: RhwpModule;
  protocol: StudioFieldAgentProtocol;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
}): NativeStudioFieldAgentTransaction {
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
        replacementStyle: "actual-input",
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
        const beforeEvidence = await collectStudioFieldEvidence(
          input.rhwp,
          commandInput.bytes,
          recovery.binding.target,
        );
        const appliedBinding: NativeFieldBindingV1 = {
          ...recovery.binding,
          target: recovery.binding.target as StudioFieldTargetV1,
          beforeText: recovery.appliedText,
          beforeTextSha256: commandInput.expectedAfterTextSha256,
          formatSha256: beforeEvidence.formatSha256,
        };
        assertBinding(appliedBinding, beforeEvidence);
        const needsExactFormatRestore = beforeEvidence.formatSha256 !== recovery.binding.formatSha256;
        if (needsExactFormatRestore && !recovery.restoreFormat) {
          throw new Error("저장된 원래 필드 서식이 없어 exact Undo를 차단했습니다.");
        }
        const state = await input.protocol.getDocumentState();
        if (state.format !== commandInput.format || state.documentSha256 !== beforeDocumentSha256) {
          throw new Error("Studio field Undo 기준 문서가 현재 검증 바이트와 다릅니다.");
        }
        const recoveryInput: Pick<NativeFieldApplyInput, "commandId" | "binding" | "replacement"> = {
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
          replacementStyle: needsExactFormatRestore ? "restore-exact" : "preserve",
          ...(needsExactFormatRestore ? {
            replacementFormat: recovery.restoreFormat,
            expectedReplacementFormatSha256: recovery.binding.formatSha256,
          } : {}),
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

interface ParagraphAppliedEntry {
  commandId: string;
  binding: ParagraphFieldBindingV1;
  replacement: string;
  receipt: StudioTextCommandReceiptV1;
  status: "applied" | "reverted";
}

function createStudioParagraphFieldAgentTransaction(input: {
  rhwp: RhwpModule;
  protocol: StudioDocumentAgentProtocol;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
}) {
  let latest: ParagraphAppliedEntry | null = null;
  return {
    async apply(commandInput: ParagraphFieldApplyInput): Promise<StudioFieldCommandResult> {
      const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
      const evidence = await collectStudioFieldEvidence(input.rhwp, commandInput.bytes, commandInput.binding.target);
      assertBinding(commandInput.binding, evidence);
      const state = await input.protocol.getDocumentState();
      if (state.format !== commandInput.format || state.documentSha256 !== beforeDocumentSha256) {
        throw new Error("Studio paragraph field 기준 문서가 현재 검증 바이트와 다릅니다.");
      }
      const target = studioBodyParagraphTargetForField(commandInput.binding.target);
      const command = studioApplyTextCommandSchema.parse({
        schemaVersion: 1,
        commandId: commandInput.commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedDocumentSha256: state.documentSha256,
        target,
        expectedBeforeSha256: commandInput.binding.beforeTextSha256,
        expectedFormatSha256: commandInput.binding.formatSha256,
        expectedAdjacentContextSha256: commandInput.binding.adjacentContextSha256,
        replacement: commandInput.replacement,
      });
      let receipt: StudioTextCommandReceiptV1;
      try {
        receipt = await input.protocol.applyTextCommand(command);
        await assertParagraphApplyReceipt(receipt, commandInput, state, target);
      } catch (error) {
        throw new StudioFieldAgentMutationVerificationError(
          "Studio paragraph field 명령 결과를 안전하게 확인하지 못했습니다.",
          error,
        );
      }
      try {
        const result = await verifyCommittedParagraphFieldMutation({
          ...input,
          format: commandInput.format,
          target: commandInput.binding.target,
          expectedText: commandInput.replacement,
          expectedFormatSha256: commandInput.binding.formatSha256,
          expectedAdjacentContextSha256: commandInput.binding.adjacentContextSha256,
          receipt,
          beforeDocumentSha256,
        });
        latest = {
          commandId: commandInput.commandId,
          binding: commandInput.binding,
          replacement: commandInput.replacement,
          receipt,
          status: "applied",
        };
        return result;
      } catch (error) {
        throw new StudioFieldAgentMutationVerificationError(
          "Studio paragraph field 적용 뒤 export 검증에 실패했습니다.",
          error,
        );
      }
    },

    async revert(commandInput: ParagraphFieldRevertInput): Promise<StudioFieldCommandResult> {
      const entry = latest;
      if (!entry || entry.status !== "applied" || entry.commandId !== commandInput.commandId) {
        const recovery = commandInput.recovery;
        if (!recovery) throw new Error("현재 Studio 세션의 가장 최근 문단 필드 적용만 되돌릴 수 있습니다.");
        const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
        if (beforeDocumentSha256 !== recovery.appliedDocumentSha256
            || await sha256Hex(recovery.appliedText) !== commandInput.expectedAfterTextSha256) {
          throw new Error("저장된 문단 필드 revision과 현재 Studio 문서가 달라 Undo를 차단했습니다.");
        }
        const appliedTarget = paragraphTargetAfterReplacement(
          recovery.binding.target,
          recovery.appliedText.length,
        );
        const evidence = await collectStudioFieldEvidence(input.rhwp, commandInput.bytes, appliedTarget);
        const appliedBinding: ParagraphFieldBindingV1 = {
          ...recovery.binding,
          target: appliedTarget,
          beforeText: recovery.appliedText,
          beforeTextSha256: commandInput.expectedAfterTextSha256,
          formatSha256: evidence.formatSha256,
        };
        assertBinding(appliedBinding, evidence);
        if (evidence.formatSha256 !== recovery.binding.formatSha256) {
          throw new Error("문단 필드의 원래 서식과 현재 서식이 달라 exact Undo를 차단했습니다.");
        }
        const state = await input.protocol.getDocumentState();
        if (state.format !== commandInput.format || state.documentSha256 !== beforeDocumentSha256) {
          throw new Error("Studio paragraph field Undo 기준 문서가 현재 검증 바이트와 다릅니다.");
        }
        const commandId = `${commandInput.commandId}:undo`;
        const bodyTarget = studioBodyParagraphTargetForField(appliedTarget);
        const command = studioApplyTextCommandSchema.parse({
          schemaVersion: 1,
          commandId,
          expectedDocumentEpoch: state.documentEpoch,
          expectedChangeSeq: state.changeSeq,
          expectedDocumentSha256: state.documentSha256,
          target: bodyTarget,
          expectedBeforeSha256: appliedBinding.beforeTextSha256,
          expectedFormatSha256: appliedBinding.formatSha256,
          expectedAdjacentContextSha256: appliedBinding.adjacentContextSha256,
          replacement: recovery.binding.beforeText,
        });
        try {
          const receipt = await input.protocol.applyTextCommand(command);
          await assertParagraphApplyReceipt(receipt, {
            ...commandInput,
            commandId,
            binding: appliedBinding,
            replacement: recovery.binding.beforeText,
          }, state, bodyTarget);
          return await verifyCommittedParagraphFieldMutation({
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
            "새 Studio 세션에서 저장된 문단 필드 적용을 되돌린 결과를 확인하지 못했습니다.",
            error,
          );
        }
      }

      const beforeDocumentSha256 = await sha256Hex(commandInput.bytes);
      const state = await input.protocol.getDocumentState();
      if (state.format !== commandInput.format
          || state.documentSha256 !== beforeDocumentSha256
          || state.documentEpoch !== entry.receipt.documentEpoch
          || state.changeSeq !== entry.receipt.afterChangeSeq
          || state.documentSha256 !== entry.receipt.afterDocumentSha256) {
        throw new Error("문단 필드 적용 뒤 Studio 문서가 변경되어 자동 Undo를 차단했습니다.");
      }
      const command = studioRevertTextCommandSchema.parse({
        schemaVersion: 1,
        commandId: commandInput.commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedAfterDocumentSha256: state.documentSha256,
        expectedAfterSha256: commandInput.expectedAfterTextSha256,
      });
      const receipt = await input.protocol.revertTextCommand(command);
      if (receipt.operation !== "revert"
          || receipt.commandId !== commandInput.commandId
          || receipt.beforeDocumentSha256 !== state.documentSha256
          || receipt.afterTextSha256 !== entry.binding.beforeTextSha256
          || receipt.formatSha256 !== entry.binding.formatSha256
          || receipt.adjacentContextSha256 !== entry.binding.adjacentContextSha256
          || !sameBodyTarget(receipt.target, studioBodyParagraphTargetForField(entry.binding.target))) {
        throw new Error("Studio paragraph field revert receipt가 승인된 binding과 다릅니다.");
      }
      const result = await verifyCommittedParagraphFieldMutation({
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

async function verifyCommittedParagraphFieldMutation(input: {
  rhwp: RhwpModule;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
  format: RhwpDocumentFormat;
  target: StudioParagraphFieldTargetV1;
  expectedText: string;
  expectedFormatSha256: string;
  expectedAdjacentContextSha256: string;
  receipt: StudioTextCommandReceiptV1;
  beforeDocumentSha256: string;
}): Promise<StudioFieldCommandResult> {
  const bytes = await input.exportCurrentBytes(input.format);
  const afterDocumentSha256 = await sha256Hex(bytes);
  if (afterDocumentSha256 !== input.receipt.afterDocumentSha256) {
    throw new Error("Studio paragraph field receipt와 검증 export의 문서 SHA가 다릅니다.");
  }
  const afterTarget = paragraphTargetAfterReplacement(input.target, input.expectedText.length);
  const evidence = await collectStudioFieldEvidence(input.rhwp, bytes, afterTarget);
  if (evidence.text !== input.expectedText
      || evidence.textSha256 !== input.receipt.afterTextSha256
      || evidence.formatSha256 !== input.expectedFormatSha256
      || evidence.adjacentContextSha256 !== input.expectedAdjacentContextSha256) {
    throw new Error("Studio paragraph field export/reopen postcondition이 승인된 값과 다릅니다.");
  }
  return {
    bytes,
    format: input.format,
    beforeDocumentSha256: input.beforeDocumentSha256,
    afterDocumentSha256,
    receipt: input.receipt,
  };
}

async function assertParagraphApplyReceipt(
  receipt: StudioTextCommandReceiptV1,
  input: { commandId: string; binding: ParagraphFieldBindingV1; replacement: string },
  state: { documentEpoch: number; changeSeq: number; documentSha256: string; pageCount: number },
  target: StudioTextCommandReceiptV1["target"],
): Promise<void> {
  if (receipt.operation !== "apply"
      || receipt.commandId !== input.commandId
      || receipt.documentEpoch !== state.documentEpoch
      || receipt.beforeChangeSeq !== state.changeSeq
      || receipt.beforeDocumentSha256 !== state.documentSha256
      || receipt.beforeTextSha256 !== input.binding.beforeTextSha256
      || receipt.afterTextSha256 !== await sha256Hex(input.replacement)
      || receipt.formatSha256 !== input.binding.formatSha256
      || receipt.adjacentContextSha256 !== input.binding.adjacentContextSha256
      || receipt.pageCountBefore !== state.pageCount
      || receipt.pageCountAfter !== state.pageCount
      || !sameBodyTarget(receipt.target, target)) {
    throw new Error("Studio paragraph field apply receipt가 승인된 exact binding과 다릅니다.");
  }
}

function paragraphTargetAfterReplacement(
  target: StudioParagraphFieldTargetV1,
  nextLength: number,
): StudioParagraphFieldTargetV1 {
  const suffixLength = target.length - target.valueEnd;
  const valueEnd = nextLength - suffixLength;
  if (valueEnd < target.valueStart) throw new Error("문단 필드 replacement가 고정 prefix/suffix보다 짧습니다.");
  return { ...target, length: nextLength, valueEnd };
}

function sameBodyTarget(
  left: StudioTextCommandReceiptV1["target"],
  right: StudioTextCommandReceiptV1["target"],
): boolean {
  return left.kind === right.kind
    && left.section === right.section
    && left.paragraph === right.paragraph
    && left.charOffset === right.charOffset
    && left.length === right.length;
}

async function verifyCommittedFieldMutation(input: {
  rhwp: RhwpModule;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
  format: RhwpDocumentFormat;
  target: StudioFieldTargetV1;
  expectedText: string;
  expectedFormatSha256?: string;
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
    || evidence.formatSha256 !== (input.expectedFormatSha256 ?? input.receipt.formatSha256)
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

export interface FieldEvidence {
  text: string;
  textSha256: string;
  formatSha256: string;
  adjacentContextSha256: string;
  restoreFormat: StudioFieldRestoreFormatV1 | null;
}

export interface NativeFieldEvidence extends Omit<FieldEvidence, "restoreFormat"> {
  restoreFormat: StudioFieldRestoreFormatV1;
}

export function collectStudioFieldEvidence(
  rhwp: RhwpModule,
  bytes: Uint8Array,
  target: StudioFieldTargetV1,
): Promise<NativeFieldEvidence>;
export function collectStudioFieldEvidence(
  rhwp: RhwpModule,
  bytes: Uint8Array,
  target: StudioFieldBindingTargetV1,
): Promise<FieldEvidence>;
export async function collectStudioFieldEvidence(
  rhwp: RhwpModule,
  bytes: Uint8Array,
  target: StudioFieldBindingTargetV1,
): Promise<FieldEvidence> {
  const document = new rhwp.HwpDocument(bytes);
  try {
    return await collectStudioFieldEvidenceFromDocument(document, target);
  } finally {
    document.free();
  }
}

/** 같은 revision의 여러 target을 한 번만 reopen하여 사이드바 점검 비용을 제한한다. */
export async function collectStudioFieldEvidenceBatch(
  rhwp: RhwpModule,
  bytes: Uint8Array,
  targets: readonly StudioFieldBindingTargetV1[],
): Promise<Array<FieldEvidence | null>> {
  const document = new rhwp.HwpDocument(bytes);
  try {
    const results: Array<FieldEvidence | null> = [];
    for (const target of targets) {
      try {
        results.push(await collectStudioFieldEvidenceFromDocument(document, target));
      } catch {
        results.push(null);
      }
    }
    return results;
  } finally {
    document.free();
  }
}

async function collectStudioFieldEvidenceFromDocument(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioFieldBindingTargetV1,
): Promise<FieldEvidence> {
  if (target.kind === "body_paragraph_text") {
    return collectStudioParagraphFieldEvidence(document, target);
  }
  if (target.kind === "form_text") {
    return await collectStudioFormTextEvidence(document, target);
  }
  const dimensions = JSON.parse(document.getTableDimensions(
    target.section,
    target.parentPara,
    target.controlIndex,
  )) as { rowCount: number; colCount: number; cellCount: number };
  if (!Number.isSafeInteger(dimensions.cellCount) || target.cellIndex >= dimensions.cellCount) {
    throw new Error("exact field table cell을 찾지 못했습니다.");
  }
  if (target.kind === "table_cell_region") {
    return await collectStudioTableCellRegionEvidence(document, target, dimensions);
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
    restoreFormat: {
      kind: "table_cell_text",
      charShapeIds,
      paraShapeId,
    },
  };
}

async function collectStudioParagraphFieldEvidence(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioParagraphFieldTargetV1,
): Promise<FieldEvidence> {
  const length = document.getParagraphLength(target.section, target.paragraph);
  if (length !== target.length || length < 1 || length > 4_000
      || target.valueStart > target.valueEnd || target.valueEnd > length) {
    throw new Error("exact paragraph field 범위가 current paragraph와 다릅니다.");
  }
  const controls = JSON.parse(document.getControlTextPositions(target.section, target.paragraph)) as unknown;
  if (!Array.isArray(controls) || controls.length > 0) {
    throw new Error("paragraph field 문단에 지원하지 않는 control이 있습니다.");
  }
  const text = document.getTextRange(target.section, target.paragraph, 0, length);
  const charProperties: Record<string, unknown>[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const fieldInfo = JSON.parse(document.getFieldInfoAt(target.section, target.paragraph, offset)) as {
      inField?: unknown;
    };
    if (fieldInfo.inField !== false) throw new Error("paragraph field가 native form field와 겹칩니다.");
    charProperties.push(readObject(document.getCharPropertiesAt(target.section, target.paragraph, offset)));
  }
  const first = charProperties[0]!;
  const firstCanonical = canonicalJson(first);
  if (charProperties.some((properties) => canonicalJson(properties) !== firstCanonical)) {
    throw new Error("paragraph field 문단의 혼합 글자 서식은 자동 입력하지 않습니다.");
  }
  const formatSnapshot = {
    charProperties: first,
    paragraphProperties: readObject(document.getParaPropertiesAt(target.section, target.paragraph)),
    style: readObject(document.getStyleAt(target.section, target.paragraph)),
  };
  const commandEvidence = await buildStudioDocumentAgentCommandEvidence({
    document,
    target: studioBodyParagraphTargetForField(target),
    formatSnapshot,
  });
  return {
    text,
    textSha256: await sha256Hex(text),
    formatSha256: commandEvidence.formatSha256,
    adjacentContextSha256: commandEvidence.adjacentContextSha256,
    restoreFormat: null,
  };
}

async function collectStudioTableCellRegionEvidence(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioTableCellRegionTargetV1,
  dimensions: { rowCount: number; colCount: number; cellCount: number },
): Promise<FieldEvidence> {
  const paragraphCount = document.getCellParagraphCount(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
  );
  if (!Number.isSafeInteger(paragraphCount) || paragraphCount < 1) {
    throw new Error("exact 장문 field table cell을 찾지 못했습니다.");
  }
  const paragraphs: string[] = [];
  const allCharShapeIds: number[] = [];
  const paraShapeIds: number[] = [];
  const restoreParagraphs: Array<{
    length: number;
    charShapeIds: number[];
    paraShapeId: number;
  }> = [];
  for (let cellParagraph = 0; cellParagraph < paragraphCount; cellParagraph += 1) {
    const length = document.getCellParagraphLength(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      cellParagraph,
    );
    const text = length > 0 ? document.getTextInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      cellParagraph,
      0,
      length,
    ) : "";
    paragraphs.push(text);
    const paragraphParaShapeId = readId(document.getCellParaPropertiesAt(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      cellParagraph,
    ), "paraShapeId");
    const paragraphCharShapeIds: number[] = [];
    for (let offset = 0; offset < Math.max(length, 1); offset += 1) {
      paragraphCharShapeIds.push(readId(document.getCellCharPropertiesAt(
        target.section,
        target.parentPara,
        target.controlIndex,
        target.cellIndex,
        cellParagraph,
        offset,
      ), "charShapeId"));
    }
    allCharShapeIds.push(...paragraphCharShapeIds);
    paraShapeIds.push(paragraphParaShapeId);
    restoreParagraphs.push({
      length,
      charShapeIds: paragraphCharShapeIds,
      paraShapeId: paragraphParaShapeId,
    });
  }
  const charShapeId = dominantId(allCharShapeIds, "장문 셀 글자 서식");
  const paraShapeId = dominantId(paraShapeIds, "장문 셀 문단 서식");
  const text = paragraphs.join("\n");
  const cellProperties = JSON.parse(document.getCellOwnProperties(
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
  )) as unknown;
  return {
    text,
    textSha256: await sha256Hex(text),
    formatSha256: await sha256Hex(stableJson({
      schemaVersion: 1,
      kind: "table_cell_region",
      charShape: { kind: "canonical", id: charShapeId },
      paraShapeId,
      cellProperties,
    })),
    adjacentContextSha256: await fieldNonTargetManifest(document, target, dimensions),
    restoreFormat: { kind: "table_cell_region", paragraphs: restoreParagraphs },
  };
}

function dominantId(ids: readonly number[], label: string): number {
  if (ids.length === 0) throw new Error(`${label}을 확인하지 못했습니다.`);
  const counts = new Map<number, number>();
  let selected = ids[0]!;
  let selectedCount = 0;
  for (const id of ids) {
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > selectedCount) {
      selected = id;
      selectedCount = count;
    }
  }
  return selected;
}

interface StudioFormFieldEntry {
  fieldId: number;
  fieldType: string;
  cellField: boolean;
  name: string;
  guide: string;
  command: string;
  value: string;
  location: { sectionIndex: number; paraIndex: number; path?: unknown[] };
  startCharIdx?: number;
  endCharIdx?: number;
  editableInForm?: boolean;
}

async function collectStudioFormTextEvidence(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioFormTextTargetV1,
): Promise<FieldEvidence> {
  const fields = parseFormFields(document);
  const matches = fields.filter(field => field.fieldId === target.fieldId);
  if (matches.length !== 1) throw new Error("exact 누름틀 fieldId를 찾지 못했습니다.");
  const field = matches[0]!;
  const path = field.location?.path;
  if (field.fieldType !== "clickhere"
      || field.cellField === true
      || field.editableInForm !== true
      || field.location?.sectionIndex !== target.section
      || field.location?.paraIndex !== target.paragraph
      || (Array.isArray(path) && path.length > 0)
      || !Number.isSafeInteger(field.startCharIdx)
      || !Number.isSafeInteger(field.endCharIdx)
      || (field.startCharIdx as number) < 0
      || (field.endCharIdx as number) < (field.startCharIdx as number)) {
    throw new Error("본문의 편집 가능한 exact 누름틀 field target이 아닙니다.");
  }
  const start = field.startCharIdx as number;
  const end = field.endCharIdx as number;
  const paragraphLength = document.getParagraphLength(target.section, target.paragraph);
  if (end > paragraphLength || paragraphLength > 4_000) {
    throw new Error("누름틀 범위가 current paragraph와 다릅니다.");
  }
  const valueResult = JSON.parse(document.getFieldValue(target.fieldId)) as { ok?: unknown; value?: unknown };
  if (valueResult.ok !== true
      || typeof valueResult.value !== "string"
      || Array.from(valueResult.value).length !== end - start) {
    throw new Error("누름틀 값과 current field 범위가 다릅니다.");
  }
  const charShapeIds: number[] = [];
  for (let offset = start; offset < Math.max(end, start + 1); offset += 1) {
    charShapeIds.push(readId(
      document.getCharPropertiesAt(target.section, target.paragraph, offset),
      "charShapeId",
    ));
  }
  const charShapeId = charShapeIds[0]!;
  const charShape = charShapeIds.every(id => id === charShapeId)
    ? { kind: "uniform", id: charShapeId }
    : { kind: "runs", ids: charShapeIds };
  const paraShapeId = readId(
    document.getParaPropertiesAt(target.section, target.paragraph),
    "paraShapeId",
  );
  const styleId = readId(document.getStyleAt(target.section, target.paragraph), "id");
  return {
    text: valueResult.value,
    textSha256: await sha256Hex(valueResult.value),
    formatSha256: await sha256Hex(stableJson({
      schemaVersion: 1,
      kind: "form_text",
      charShape,
      paraShapeId,
      styleId,
      field: {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        name: field.name,
        guide: field.guide,
        command: field.command,
        editableInForm: field.editableInForm,
      },
    })),
    adjacentContextSha256: await formNonTargetManifest(document, target, field, fields),
    restoreFormat: {
      kind: "form_text",
      charShapeIds,
      paraShapeId,
      styleId,
    },
  };
}

async function formNonTargetManifest(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioFormTextTargetV1,
  field: StudioFormFieldEntry & { startCharIdx?: number; endCharIdx?: number },
  fields: StudioFormFieldEntry[],
): Promise<string> {
  const start = field.startCharIdx as number;
  const end = field.endCharIdx as number;
  const paragraphs: Array<Record<string, unknown>> = [];
  for (let section = 0; section < document.getSectionCount(); section += 1) {
    for (let paragraph = 0; paragraph < document.getParagraphCount(section); paragraph += 1) {
      if (section !== target.section || paragraph !== target.paragraph) {
        paragraphs.push(await formParagraphSemantic(document, section, paragraph));
        continue;
      }
      const length = document.getParagraphLength(section, paragraph);
      paragraphs.push({
        section,
        paragraph,
        prefixTextSha256: await sha256Hex(textSlice(document, section, paragraph, 0, start)),
        suffixTextSha256: await sha256Hex(textSlice(document, section, paragraph, end, length)),
        prefixCharShapeIds: formCharShapeSlice(document, section, paragraph, 0, start),
        suffixCharShapeIds: formCharShapeSlice(document, section, paragraph, end, length),
        paraShapeId: readId(document.getParaPropertiesAt(section, paragraph), "paraShapeId"),
        styleId: readId(document.getStyleAt(section, paragraph), "id"),
      });
    }
  }
  const otherFields = fields
    .filter(entry => entry.fieldId !== target.fieldId)
    .filter(entry => entry.location?.sectionIndex !== target.section
      || entry.location?.paraIndex !== target.paragraph)
    .map(entry => ({
      fieldId: entry.fieldId,
      fieldType: entry.fieldType,
      cellField: entry.cellField,
      name: entry.name,
      guide: entry.guide,
      command: entry.command,
      value: entry.value,
      location: entry.location,
      startCharIdx: entry.startCharIdx,
      endCharIdx: entry.endCharIdx,
      editableInForm: entry.editableInForm,
    }));
  return sha256Hex(stableJson({
    schemaVersion: 1,
    sectionCount: document.getSectionCount(),
    paragraphCounts: Array.from(
      { length: document.getSectionCount() },
      (_, section) => document.getParagraphCount(section),
    ),
    paragraphs,
    otherFields,
  }));
}

async function formParagraphSemantic(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  section: number,
  paragraph: number,
): Promise<Record<string, unknown>> {
  const length = document.getParagraphLength(section, paragraph);
  const text = length > 0 ? document.getTextRange(section, paragraph, 0, length) : "";
  return {
    section,
    paragraph,
    length,
    textSha256: await sha256Hex(text),
    paraShapeId: readId(document.getParaPropertiesAt(section, paragraph), "paraShapeId"),
    styleId: readId(document.getStyleAt(section, paragraph), "id"),
    charShapeIds: formCharShapeSlice(document, section, paragraph, 0, Math.max(length, 1)),
    controls: JSON.parse(document.getControlTextPositions(section, paragraph)) as unknown,
  };
}

function formCharShapeSlice(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  section: number,
  paragraph: number,
  start: number,
  end: number,
): number[] {
  const ids: number[] = [];
  for (let offset = start; offset < end; offset += 1) {
    ids.push(readId(document.getCharPropertiesAt(section, paragraph, offset), "charShapeId"));
  }
  return ids;
}

function textSlice(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  section: number,
  paragraph: number,
  start: number,
  end: number,
): string {
  return end > start ? document.getTextRange(section, paragraph, start, end - start) : "";
}

function parseFormFields(document: InstanceType<RhwpModule["HwpDocument"]>): StudioFormFieldEntry[] {
  const parsed = JSON.parse(document.getFieldList()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("누름틀 필드 목록이 배열이 아닙니다.");
  return parsed as StudioFormFieldEntry[];
}

async function fieldNonTargetManifest(
  document: InstanceType<RhwpModule["HwpDocument"]>,
  target: StudioTableCellTextTargetV1 | StudioTableCellRegionTargetV1,
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
      if (cellIndex === target.cellIndex && (
        target.kind === "table_cell_region"
        || cellParagraph === target.cellParagraph
      )) continue;
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
      ...(cellIndex === target.cellIndex && target.kind === "table_cell_region"
        ? { targetRegion: true }
        : { paragraphCount }),
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
  const parsed = readObject(value);
  const id = parsed[key];
  if (!Number.isSafeInteger(id) || (id as number) < 0) throw new Error(`${key}가 올바르지 않습니다.`);
  return id as number;
}

function readObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RHWP evidence JSON이 객체가 아닙니다.");
  }
  return parsed as Record<string, unknown>;
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
  input: { commandId: string; binding: NativeFieldBindingV1; replacement: string },
  state: { documentEpoch: number; changeSeq: number; documentSha256: string; pageCount: number },
): void {
  if (
    receipt.operation !== "apply"
    || receipt.commandId !== input.commandId
    || receipt.documentEpoch !== state.documentEpoch
    || receipt.beforeChangeSeq !== state.changeSeq
    || receipt.beforeDocumentSha256 !== state.documentSha256
    || receipt.beforeTextSha256 !== input.binding.beforeTextSha256
    || receipt.adjacentContextSha256 !== input.binding.adjacentContextSha256
    || receipt.pageCountBefore !== state.pageCount
    || (input.binding.target.kind !== "table_cell_region" && receipt.pageCountAfter !== state.pageCount)
    || !sameTarget(receipt.target, input.binding.target)
  ) throw new Error("Studio field apply receipt가 승인된 exact binding과 다릅니다.");
}

function sameTarget(left: StudioFieldTargetV1, right: StudioFieldTargetV1): boolean {
  if (left.kind !== right.kind || left.section !== right.section) return false;
  if (left.kind === "form_text" && right.kind === "form_text") {
    return left.paragraph === right.paragraph && left.fieldId === right.fieldId;
  }
  if (left.kind === "table_cell_text" && right.kind === "table_cell_text") {
    return left.parentPara === right.parentPara
      && left.controlIndex === right.controlIndex
      && left.cellIndex === right.cellIndex
      && left.cellParagraph === right.cellParagraph;
  }
  if (left.kind === "table_cell_region" && right.kind === "table_cell_region") {
    return left.parentPara === right.parentPara
      && left.controlIndex === right.controlIndex
      && left.cellIndex === right.cellIndex;
  }
  return false;
}
