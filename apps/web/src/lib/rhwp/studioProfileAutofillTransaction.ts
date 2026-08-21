import type { RhwpDocumentFormat, RhwpModule } from "./client";
import { isReplaceableRhwpGuide } from "./guideText";
import type { StudioFieldAgentProtocol, StudioFieldTargetV1 } from "./studioDocumentAgentProtocol";
import {
  collectStudioFieldEvidence,
  createStudioFieldAgentTransaction,
  StudioFieldAgentMutationVerificationError,
  type FieldCommandBindingV1,
  type StudioFieldCommandResult,
} from "./studioFieldAgentTransaction";

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
  restoreFormat: Awaited<ReturnType<typeof collectStudioFieldEvidence>>["restoreFormat"];
  result: StudioFieldCommandResult;
}

export interface StudioProfileAutofillBatchResult {
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
  const transaction = () => createStudioFieldAgentTransaction(input);
  return {
    async apply(batch: {
      bytes: Uint8Array;
      format: RhwpDocumentFormat;
      entries: readonly StudioProfileAutofillEntry[];
    }): Promise<StudioProfileAutofillBatchResult> {
      assertUniqueFieldIds(batch.entries);
      let bytes = batch.bytes;
      const applied: AppliedStudioProfileAutofillEntry[] = [];
      for (const [index, entry] of batch.entries.entries()) {
        const evidence = await collectStudioFieldEvidence(input.rhwp, bytes, entry.target);
        const before = evidence.text.trim();
        if (before && !isReplaceableRhwpGuide(before, entry.sourceSpan, null)) {
          throw new StudioProfileAutofillTransactionError(
            `'${entry.label}' 입력 칸에 현재 값이 있어 일괄 입력을 중단했습니다.`,
            false,
            undefined,
            { bytes, format: batch.format, applied },
          );
        }
        const binding: FieldCommandBindingV1 = {
          target: entry.target,
          beforeText: evidence.text,
          beforeTextSha256: evidence.textSha256,
          formatSha256: evidence.formatSha256,
          adjacentContextSha256: evidence.adjacentContextSha256,
        };
        const commandId = `profile-autofill:${crypto.randomUUID()}:${index}`;
        try {
          const result = await transaction().apply({
            bytes,
            format: batch.format,
            commandId,
            binding,
            replacement: entry.value,
          });
          applied.push({
            fieldId: entry.fieldId,
            label: entry.label,
            value: entry.value,
            target: entry.target,
            commandId,
            binding,
            restoreFormat: evidence.restoreFormat,
            result,
          });
          bytes = result.bytes;
        } catch (error) {
          throw new StudioProfileAutofillTransactionError(
            `'${entry.label}' 입력 결과를 안전하게 확인하지 못했습니다.`,
            error instanceof StudioFieldAgentMutationVerificationError,
            error,
            { bytes, format: batch.format, applied },
          );
        }
      }
      return { bytes, format: batch.format, applied };
    },

    async revert(batch: StudioProfileAutofillBatchResult): Promise<Uint8Array> {
      let bytes = batch.bytes;
      for (const entry of [...batch.applied].reverse()) {
        const reverted = await transaction().revert({
          bytes,
          format: batch.format,
          commandId: entry.commandId,
          expectedAfterTextSha256: entry.result.receipt.afterTextSha256,
          recovery: {
            appliedDocumentSha256: entry.result.afterDocumentSha256,
            appliedText: entry.value,
            binding: entry.binding,
            restoreFormat: entry.restoreFormat,
          },
        });
        bytes = reverted.bytes;
      }
      return bytes;
    },
  };
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
