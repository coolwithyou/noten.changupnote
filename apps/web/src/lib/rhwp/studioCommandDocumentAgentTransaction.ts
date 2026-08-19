import {
  assertDocumentEditCandidateIntegrity,
  assertSafeReplacement,
  decodeDocumentEditCandidate,
  sha256Hex,
  type DocumentEditCandidate,
} from "./documentAgentContract";
import {
  assertDocumentAgentTargetMutation,
  buildDocumentAgentSemanticManifest,
} from "./documentAgentManifest";
import type {
  DocumentAgentApplyInput,
  DocumentAgentTransaction,
  DocumentAgentUndoInput,
  VerifiedEditResult,
} from "./documentAgentTransaction";
import type { RhwpModule } from "./client";
import {
  studioApplyTextCommandSchema,
  studioRevertTextCommandSchema,
  type StudioDocumentAgentProtocol,
  type StudioFocusTargetResultV1,
  type StudioTextCommandReceiptV1,
} from "./studioDocumentAgentProtocol";

export interface StudioCommandResult extends VerifiedEditResult {
  studioReceipt: StudioTextCommandReceiptV1;
  focus: StudioFocusTargetResultV1 & { error?: string };
}

export interface StudioCommandDocumentAgentTransaction extends DocumentAgentTransaction {
  apply(input: DocumentAgentApplyInput): Promise<StudioCommandResult>;
  undo(input: DocumentAgentUndoInput): Promise<StudioCommandResult>;
}

interface AppliedJournalEntry {
  candidateId: string;
  commandId: string;
  afterText: string;
  receipt: StudioTextCommandReceiptV1;
  status: "applied" | "reverted";
}

export class StudioDocumentAgentVerificationError extends Error {
  readonly mutationCommitted = true;
  readonly receipt: StudioTextCommandReceiptV1;
  readonly cause: unknown;

  constructor(message: string, receipt: StudioTextCommandReceiptV1, cause: unknown) {
    super(message);
    this.name = "StudioDocumentAgentVerificationError";
    this.receipt = receipt;
    this.cause = cause;
  }
}

/**
 * Studio in-memory command를 기존 DocumentAgentTransaction seam에 맞춘다.
 * 명령 receipt 뒤의 export/manifest 검증이 실패하면 저장하지 않고 상위 UI가 잠금을 유지해야 한다.
 */
export function createStudioCommandDocumentAgentTransaction(input: {
  rhwp: RhwpModule;
  protocol: StudioDocumentAgentProtocol;
  exportCurrentBytes(format: "hwp" | "hwpx"): Promise<Uint8Array>;
  createCommandId?: () => string;
}): StudioCommandDocumentAgentTransaction {
  let latest: AppliedJournalEntry | null = null;
  const createCommandId = input.createCommandId ?? (() => crypto.randomUUID());

  return {
    async apply(transactionInput): Promise<StudioCommandResult> {
      const candidate = decodeDocumentEditCandidate(transactionInput.command.candidate);
      await assertDocumentEditCandidateIntegrity(candidate);
      assertSafeReplacement(transactionInput.command.replacement);
      const beforeDocumentSha256 = await sha256Hex(transactionInput.bytes);
      if (beforeDocumentSha256 !== candidate.documentSha256) {
        throw new Error("AI 문서 치환 기준 전체 문서 SHA가 현재 Studio 바이트와 다릅니다.");
      }

      const state = await input.protocol.getDocumentState();
      assertStateMatchesInput(state, transactionInput.format, beforeDocumentSha256);
      const commandId = createCommandId();
      const command = studioApplyTextCommandSchema.parse({
        schemaVersion: 1,
        commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedDocumentSha256: state.documentSha256,
        target: candidate.anchor,
        expectedBeforeSha256: candidate.beforeSha256,
        expectedFormatSha256: candidate.studioCommandEvidence.formatSha256,
        expectedAdjacentContextSha256: candidate.studioCommandEvidence.adjacentContextSha256,
        replacement: transactionInput.command.replacement,
      });

      const receipt = await input.protocol.applyTextCommand(command);
      try {
        await assertApplyReceipt({
          receipt,
          commandId,
          state,
          candidate,
          replacement: transactionInput.command.replacement,
        });
        const verified = await verifyCommittedStudioMutation({
          rhwp: input.rhwp,
          exportCurrentBytes: input.exportCurrentBytes,
          format: transactionInput.format,
          beforeBytes: transactionInput.bytes,
          beforeDocumentSha256,
          receipt,
          candidate,
          replacement: transactionInput.command.replacement,
          operation: "apply",
        });
        latest = {
          candidateId: candidate.candidateId,
          commandId,
          afterText: transactionInput.command.replacement,
          receipt,
          status: "applied",
        };
        return {
          ...verified,
          studioReceipt: receipt,
          focus: await focusWithoutInvalidatingReceipt(
            input.protocol,
            { ...candidate.anchor, length: codePointLength(transactionInput.command.replacement) },
            candidate.location.page,
          ),
        };
      } catch (error) {
        if (error instanceof StudioDocumentAgentVerificationError) throw error;
        throw new StudioDocumentAgentVerificationError(
          "Studio apply는 commit됐지만 export/receipt 검증이 실패했습니다.",
          receipt,
          error,
        );
      }
    },

    async undo(transactionInput): Promise<StudioCommandResult> {
      const candidate = decodeDocumentEditCandidate(transactionInput.command.candidate);
      await assertDocumentEditCandidateIntegrity(candidate);
      assertSafeReplacement(transactionInput.command.afterText);
      const entry = latest;
      if (
        !entry
        || entry.status !== "applied"
        || entry.candidateId !== candidate.candidateId
        || entry.afterText !== transactionInput.command.afterText
      ) {
        throw new Error("현재 Studio 세션의 가장 최근 AI 명령만 되돌릴 수 있습니다.");
      }
      const beforeDocumentSha256 = await sha256Hex(transactionInput.bytes);
      const state = await input.protocol.getDocumentState();
      assertStateMatchesInput(state, transactionInput.format, beforeDocumentSha256);
      if (
        state.documentEpoch !== entry.receipt.documentEpoch
        || state.changeSeq !== entry.receipt.afterChangeSeq
        || state.documentSha256 !== entry.receipt.afterDocumentSha256
      ) {
        throw new Error("Studio 문서가 AI apply receipt 이후 변경되어 revert를 차단했습니다.");
      }

      const command = studioRevertTextCommandSchema.parse({
        schemaVersion: 1,
        commandId: entry.commandId,
        expectedDocumentEpoch: state.documentEpoch,
        expectedChangeSeq: state.changeSeq,
        expectedAfterDocumentSha256: state.documentSha256,
        expectedAfterSha256: entry.receipt.afterTextSha256,
      });
      const receipt = await input.protocol.revertTextCommand(command);
      try {
        await assertRevertReceipt({ receipt, state, entry, candidate });
        const verified = await verifyCommittedStudioMutation({
          rhwp: input.rhwp,
          exportCurrentBytes: input.exportCurrentBytes,
          format: transactionInput.format,
          beforeBytes: transactionInput.bytes,
          beforeDocumentSha256,
          receipt,
          candidate,
          replacement: candidate.beforeText,
          operation: "undo",
        });
        entry.status = "reverted";
        return {
          ...verified,
          studioReceipt: receipt,
          focus: await focusWithoutInvalidatingReceipt(
            input.protocol,
            candidate.anchor,
            candidate.location.page,
          ),
        };
      } catch (error) {
        if (error instanceof StudioDocumentAgentVerificationError) throw error;
        throw new StudioDocumentAgentVerificationError(
          "Studio revert는 commit됐지만 export/receipt 검증이 실패했습니다.",
          receipt,
          error,
        );
      }
    },
  };
}

async function verifyCommittedStudioMutation(input: {
  rhwp: RhwpModule;
  exportCurrentBytes(format: "hwp" | "hwpx"): Promise<Uint8Array>;
  format: "hwp" | "hwpx";
  beforeBytes: Uint8Array;
  beforeDocumentSha256: string;
  receipt: StudioTextCommandReceiptV1;
  candidate: DocumentEditCandidate;
  replacement: string;
  operation: "apply" | "undo";
}): Promise<VerifiedEditResult> {
  const bytes = await input.exportCurrentBytes(input.format);
  const afterDocumentSha256 = await sha256Hex(bytes);
  if (afterDocumentSha256 !== input.receipt.afterDocumentSha256) {
    throw new Error("Studio command receipt와 검증 export의 문서 SHA가 다릅니다.");
  }
  const beforeDocument = new input.rhwp.HwpDocument(input.beforeBytes);
  const afterDocument = new input.rhwp.HwpDocument(bytes);
  try {
    const [beforeManifest, afterManifest] = await Promise.all([
      buildDocumentAgentSemanticManifest(beforeDocument),
      buildDocumentAgentSemanticManifest(afterDocument),
    ]);
    assertDocumentAgentTargetMutation({
      before: beforeManifest,
      after: afterManifest,
      target: input.candidate.anchor,
      expectedTextSha256: await sha256Hex(input.replacement),
      expectedFormatSha256: input.candidate.formatSha256,
    });
    return {
      operation: input.operation,
      bytes,
      format: input.format,
      beforeManifest,
      afterManifest,
      beforeDocumentSha256: input.beforeDocumentSha256,
      afterDocumentSha256,
    };
  } finally {
    beforeDocument.free();
    afterDocument.free();
  }
}

function assertStateMatchesInput(
  state: Awaited<ReturnType<StudioDocumentAgentProtocol["getDocumentState"]>>,
  format: "hwp" | "hwpx",
  documentSha256: string,
): void {
  if (state.format !== format || state.documentSha256 !== documentSha256) {
    throw new Error("Studio document state가 검증한 현재 바이트와 다릅니다.");
  }
}

async function assertApplyReceipt(input: {
  receipt: StudioTextCommandReceiptV1;
  commandId: string;
  state: Awaited<ReturnType<StudioDocumentAgentProtocol["getDocumentState"]>>;
  candidate: DocumentEditCandidate;
  replacement: string;
}): Promise<void> {
  const afterTextSha256 = await sha256Hex(input.replacement);
  const receipt = input.receipt;
  if (
    receipt.operation !== "apply"
    || receipt.commandId !== input.commandId
    || receipt.documentEpoch !== input.state.documentEpoch
    || receipt.beforeChangeSeq !== input.state.changeSeq
    || receipt.beforeDocumentSha256 !== input.state.documentSha256
    || receipt.beforeTextSha256 !== input.candidate.beforeSha256
    || receipt.afterTextSha256 !== afterTextSha256
    || receipt.formatSha256 !== input.candidate.studioCommandEvidence.formatSha256
    || receipt.adjacentContextSha256 !== input.candidate.studioCommandEvidence.adjacentContextSha256
    || receipt.pageCountBefore !== input.state.pageCount
    || receipt.pageCountAfter !== input.state.pageCount
    || !sameTarget(receipt.target, input.candidate.anchor)
  ) {
    throw new Error("Studio apply receipt가 요청한 exact command binding과 다릅니다.");
  }
}

async function assertRevertReceipt(input: {
  receipt: StudioTextCommandReceiptV1;
  state: Awaited<ReturnType<StudioDocumentAgentProtocol["getDocumentState"]>>;
  entry: AppliedJournalEntry;
  candidate: DocumentEditCandidate;
}): Promise<void> {
  const beforeTextSha256 = await sha256Hex(input.candidate.beforeText);
  const receipt = input.receipt;
  if (
    receipt.operation !== "revert"
    || receipt.commandId !== input.entry.commandId
    || receipt.documentEpoch !== input.state.documentEpoch
    || receipt.beforeChangeSeq !== input.state.changeSeq
    || receipt.beforeDocumentSha256 !== input.state.documentSha256
    || receipt.beforeTextSha256 !== input.entry.receipt.afterTextSha256
    || receipt.afterTextSha256 !== beforeTextSha256
    || receipt.formatSha256 !== input.candidate.studioCommandEvidence.formatSha256
    || receipt.adjacentContextSha256 !== input.candidate.studioCommandEvidence.adjacentContextSha256
    || receipt.pageCountBefore !== input.entry.receipt.pageCountAfter
    || receipt.pageCountAfter !== input.entry.receipt.pageCountBefore
    || !sameTarget(receipt.target, input.candidate.anchor)
  ) {
    throw new Error("Studio revert receipt가 최근 apply binding과 다릅니다.");
  }
}

function sameTarget(left: StudioTextCommandReceiptV1["target"], right: DocumentEditCandidate["anchor"]): boolean {
  return left.kind === right.kind
    && left.section === right.section
    && left.paragraph === right.paragraph
    && left.charOffset === right.charOffset
    && left.length === right.length;
}

async function focusWithoutInvalidatingReceipt(
  protocol: StudioDocumentAgentProtocol,
  target: DocumentEditCandidate["anchor"],
  fallbackPage: number,
): Promise<StudioFocusTargetResultV1 & { error?: string }> {
  try {
    return await protocol.focusTarget(target);
  } catch (error) {
    return {
      focused: false,
      page: fallbackPage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
