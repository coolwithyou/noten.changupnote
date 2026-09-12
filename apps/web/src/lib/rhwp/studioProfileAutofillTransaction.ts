import type { RhwpDocumentFormat, RhwpModule } from "./client";
import { sha256Hex } from "./documentAgentContract";
import { isReplaceableRhwpGuide } from "./guideText";
import type {
  StudioFieldAgentProtocol,
  StudioFieldRestoreFormatV1,
  StudioFieldTargetV1,
} from "./studioDocumentAgentProtocol";
import {
  collectStudioFieldEvidence,
  createStudioFieldAgentTransaction,
  StudioFieldAgentMutationVerificationError,
  type FieldCommandBindingV1,
  type StudioFieldCommandResult,
} from "./studioFieldAgentTransaction";
import { studioFieldDocumentSemanticSha256 } from "./studioFieldDocumentManifest";

export interface StudioProfileAutofillEntry {
  fieldId: string;
  label: string;
  sourceSpan: string | null;
  target: StudioFieldTargetV1;
  value: string;
}

export interface AppliedStudioProfileAutofillEntry {
  fieldId: string;
  label: string;
  value: string;
  target: StudioFieldTargetV1;
  commandId: string;
  binding: FieldCommandBindingV1;
  restoreFormat: StudioFieldRestoreFormatV1;
  beforeSemanticSha256: string;
  afterSemanticSha256: string;
  result: StudioFieldCommandResult;
}

export interface StudioProfileAutofillBatchResult {
  beforeBytes: Uint8Array;
  beforeSemanticSha256: string;
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  applied: AppliedStudioProfileAutofillEntry[];
}

export class StudioProfileAutofillTransactionError extends Error {
  constructor(
    message: string,
    readonly mutationUncertain: boolean,
    readonly cause?: unknown,
    readonly partial?: StudioProfileAutofillBatchResult,
  ) {
    super(message);
    this.name = "StudioProfileAutofillTransactionError";
  }
}

/**
 * 여러 필드를 하나의 승인 단위로 다루는 깊은 모듈이다. 각 필드마다 current bytes에서 exact
 * preimage를 다시 수집하고, 실패 시 caller가 역순 복구할 수 있는 영수증을 반환한다.
 */
export function createStudioProfileAutofillTransaction(input: {
  rhwp: RhwpModule;
  protocol: StudioFieldAgentProtocol;
  exportCurrentBytes(format: RhwpDocumentFormat): Promise<Uint8Array>;
}) {
  const transaction = () => createStudioFieldAgentTransaction({
    rhwp: input.rhwp,
    fieldProtocol: input.protocol,
    documentProtocol: null,
    exportCurrentBytes: input.exportCurrentBytes,
  });
  return {
    async apply(batch: {
      bytes: Uint8Array;
      format: RhwpDocumentFormat;
      entries: readonly StudioProfileAutofillEntry[];
    }): Promise<StudioProfileAutofillBatchResult> {
      assertUniqueFieldIds(batch.entries);
      const beforeBytes = batch.bytes.slice();
      let bytes: Uint8Array = beforeBytes;
      const beforeSemanticSha256 = await semanticDocumentSha256(input.rhwp, beforeBytes);
      const applied: AppliedStudioProfileAutofillEntry[] = [];
      for (const [index, entry] of batch.entries.entries()) {
        let failureMessage = `'${entry.label}' 입력 결과를 안전하게 확인하지 못했습니다.`;
        let result: StudioFieldCommandResult | null = null;
        try {
          const evidence = await collectStudioFieldEvidence(input.rhwp, bytes, entry.target);
          const entryBeforeSemanticSha256 = await semanticDocumentSha256(input.rhwp, bytes);
          const before = evidence.text.trim();
          if (before && !isReplaceableRhwpGuide(before, entry.sourceSpan, null)) {
            failureMessage = `'${entry.label}' 입력 칸에 현재 값이 있어 일괄 입력을 중단했습니다.`;
            throw new Error(failureMessage);
          }
          const binding: FieldCommandBindingV1 = {
            target: entry.target,
            beforeText: evidence.text,
            beforeTextSha256: evidence.textSha256,
            formatSha256: evidence.formatSha256,
            adjacentContextSha256: evidence.adjacentContextSha256,
          };
          if (!evidence.restoreFormat) {
            failureMessage = `'${entry.label}'의 원래 서식을 봉인하지 못했습니다.`;
            throw new Error(failureMessage);
          }
          const commandId = `profile-autofill:${crypto.randomUUID()}:${index}`;
          result = await transaction().apply({
            bytes,
            format: batch.format,
            commandId,
            binding,
            replacement: entry.value,
          });
          const entryAfterSemanticSha256 = await semanticDocumentSha256(input.rhwp, result.bytes);
          applied.push({
            fieldId: entry.fieldId,
            label: entry.label,
            value: entry.value,
            target: entry.target,
            commandId,
            binding,
            restoreFormat: evidence.restoreFormat,
            beforeSemanticSha256: entryBeforeSemanticSha256,
            afterSemanticSha256: entryAfterSemanticSha256,
            result,
          });
          bytes = result.bytes;
        } catch (error) {
          throw new StudioProfileAutofillTransactionError(
            failureMessage,
            result !== null || error instanceof StudioFieldAgentMutationVerificationError,
            error,
            {
              beforeBytes,
              beforeSemanticSha256,
              bytes,
              format: batch.format,
              applied,
            },
          );
        }
      }
      return {
        beforeBytes,
        beforeSemanticSha256,
        bytes,
        format: batch.format,
        applied,
      };
    },

    async revert(batch: StudioProfileAutofillBatchResult): Promise<Uint8Array> {
      if (batch.applied.length === 0) return batch.beforeBytes;
      let bytes = await input.exportCurrentBytes(batch.format);
      const entries = [...batch.applied].reverse();
      for (const [reverseIndex, entry] of entries.entries()) {
        const currentDocumentSha256 = await sha256Hex(bytes);
        if (reverseIndex === 0 && currentDocumentSha256 !== entry.result.afterDocumentSha256) {
          throw new Error("회사 정보 자동 입력 뒤 현재 문서가 달라 Undo를 차단했습니다.");
        }
        await assertSealedIntermediate({
          rhwp: input.rhwp,
          bytes,
          entry,
          expectedSemanticSha256: entry.afterSemanticSha256,
          expectedTextSha256: entry.result.receipt.afterTextSha256,
          expectedFormatSha256: entry.result.receipt.formatSha256,
          expectedAdjacentContextSha256: entry.result.receipt.adjacentContextSha256,
          message: "현재 문서 내용이나 서식이 회사 정보 자동 입력 직후와 달라 Undo를 차단했습니다.",
        });
        const reverted = await transaction().revert({
          bytes,
          format: batch.format,
          commandId: entry.commandId,
          expectedAfterTextSha256: entry.result.receipt.afterTextSha256,
          recovery: {
            appliedDocumentSha256: currentDocumentSha256,
            appliedText: entry.value,
            binding: entry.binding,
            restoreFormat: entry.restoreFormat,
          },
        });
        await assertSealedIntermediate({
          rhwp: input.rhwp,
          bytes: reverted.bytes,
          entry,
          expectedSemanticSha256: entry.beforeSemanticSha256,
          expectedTextSha256: entry.binding.beforeTextSha256,
          expectedFormatSha256: entry.binding.formatSha256,
          expectedAdjacentContextSha256: entry.binding.adjacentContextSha256,
          message: "회사 정보 자동 입력 역변경 결과가 원래 문서 내용과 서식을 복원하지 못했습니다.",
        });
        bytes = reverted.bytes;
      }
      if (await semanticDocumentSha256(input.rhwp, bytes) !== batch.beforeSemanticSha256) {
        throw new Error("회사 정보 자동 입력 Undo가 원래 문서의 내용과 서식을 복원하지 못했습니다.");
      }
      await assertOriginalFieldEvidence(input.rhwp, batch.beforeBytes, bytes, batch.applied);
      return bytes;
    },
  };
}

async function semanticDocumentSha256(rhwp: RhwpModule, bytes: Uint8Array): Promise<string> {
  const document = new rhwp.HwpDocument(bytes);
  try {
    return await studioFieldDocumentSemanticSha256(document);
  } finally {
    document.free();
  }
}

async function assertSealedIntermediate(input: {
  rhwp: RhwpModule;
  bytes: Uint8Array;
  entry: AppliedStudioProfileAutofillEntry;
  expectedSemanticSha256: string;
  expectedTextSha256: string;
  expectedFormatSha256: string;
  expectedAdjacentContextSha256: string;
  message: string;
}): Promise<void> {
  const semanticSha256 = await semanticDocumentSha256(input.rhwp, input.bytes);
  const evidence = await collectStudioFieldEvidence(input.rhwp, input.bytes, input.entry.target);
  if (
    semanticSha256 !== input.expectedSemanticSha256
    || evidence.textSha256 !== input.expectedTextSha256
    || evidence.formatSha256 !== input.expectedFormatSha256
    || evidence.adjacentContextSha256 !== input.expectedAdjacentContextSha256
  ) {
    throw new Error(input.message);
  }
}

async function assertOriginalFieldEvidence(
  rhwp: RhwpModule,
  beforeBytes: Uint8Array,
  revertedBytes: Uint8Array,
  entries: readonly AppliedStudioProfileAutofillEntry[],
): Promise<void> {
  for (const entry of entries) {
    const [before, reverted] = await Promise.all([
      collectStudioFieldEvidence(rhwp, beforeBytes, entry.target),
      collectStudioFieldEvidence(rhwp, revertedBytes, entry.target),
    ]);
    if (
      reverted.textSha256 !== before.textSha256
      || reverted.formatSha256 !== before.formatSha256
      || reverted.adjacentContextSha256 !== before.adjacentContextSha256
    ) {
      throw new Error("회사 정보 자동 입력 Undo가 원래 입력 칸의 내용과 서식을 복원하지 못했습니다.");
    }
  }
}

function assertUniqueFieldIds(entries: readonly StudioProfileAutofillEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.fieldId || seen.has(entry.fieldId)) {
      throw new StudioProfileAutofillTransactionError("일괄 입력 대상 fieldId가 비어 있거나 중복되었습니다.", false);
    }
    if (!entry.value.trim()) {
      throw new StudioProfileAutofillTransactionError(`'${entry.label}'에 입력할 값이 없습니다.`, false);
    }
    seen.add(entry.fieldId);
  }
}
