import {
  assertSafeReplacement,
  assertDocumentEditCandidateIntegrity,
  decodeDocumentEditCandidate,
  sha256Hex,
  type DocumentAgentReservedAnchor,
  type DocumentEditCandidate,
  type ExactEditCommand,
  type ExactUndoCommand,
} from "./documentAgentContract";
import { validateBodyParagraphCandidate } from "./documentAgentCandidates";
import {
  assertDocumentAgentManifestsEqual,
  assertDocumentAgentTargetMutation,
  buildDocumentAgentSemanticManifest,
  type DocumentAgentSemanticManifest,
} from "./documentAgentManifest";
import {
  exportVerifiedRhwpDocument,
  type RhwpDocument,
  type RhwpDocumentFormat,
  type RhwpModule,
} from "./client";

export interface VerifiedEditResult {
  operation: "apply" | "undo";
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  beforeManifest: DocumentAgentSemanticManifest;
  afterManifest: DocumentAgentSemanticManifest;
  beforeDocumentSha256: string;
  afterDocumentSha256: string;
}

export interface DocumentAgentApplyInput {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  command: ExactEditCommand;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
}

export interface DocumentAgentUndoInput {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  command: ExactUndoCommand;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
}

export interface DocumentAgentTransaction {
  apply(input: DocumentAgentApplyInput): Promise<VerifiedEditResult>;
  undo(input: DocumentAgentUndoInput): Promise<VerifiedEditResult>;
}

export function createDocumentAgentTransaction(rhwp: RhwpModule): DocumentAgentTransaction {
  return {
    apply: (input) => applyDocumentAgentEdit({ rhwp, ...input }),
    undo: (input) => undoDocumentAgentEdit({ rhwp, ...input }),
  };
}

export async function applyDocumentAgentEdit(input: {
  rhwp: RhwpModule;
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  command: ExactEditCommand;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
}): Promise<VerifiedEditResult> {
  const candidate = decodeDocumentEditCandidate(input.command.candidate);
  await assertDocumentEditCandidateIntegrity(candidate);
  assertSafeReplacement(input.command.replacement);
  const beforeDocumentSha256 = await sha256Hex(input.bytes);
  if (beforeDocumentSha256 !== candidate.documentSha256) {
    throw new Error("AI 문서 치환 기준 전체 문서 SHA가 현재 Studio 바이트와 다릅니다.");
  }
  const document = new input.rhwp.HwpDocument(input.bytes);
  try {
    const rebuilt = await validateBodyParagraphCandidate({
      document,
      sourceKey: candidate.sourceKey,
      documentSha256: beforeDocumentSha256,
      selectedPage: candidate.location.page,
      reservedAnchors: input.reservedAnchors,
      anchor: candidate.anchor,
    });
    await assertCandidatePreimage(candidate, rebuilt, candidate.beforeText);
    return await mutateExactParagraph({
      rhwp: input.rhwp,
      document,
      format: input.format,
      candidate,
      replacement: input.command.replacement,
      operation: "apply",
      beforeDocumentSha256,
    });
  } finally {
    document.free();
  }
}

export async function undoDocumentAgentEdit(input: {
  rhwp: RhwpModule;
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  command: ExactUndoCommand;
  reservedAnchors: readonly DocumentAgentReservedAnchor[];
}): Promise<VerifiedEditResult> {
  const candidate = decodeDocumentEditCandidate(input.command.candidate);
  await assertDocumentEditCandidateIntegrity(candidate);
  assertSafeReplacement(input.command.afterText);
  const beforeDocumentSha256 = await sha256Hex(input.bytes);
  const document = new input.rhwp.HwpDocument(input.bytes);
  try {
    const current = await validateBodyParagraphCandidate({
      document,
      sourceKey: candidate.sourceKey,
      documentSha256: beforeDocumentSha256,
      selectedPage: candidate.location.page,
      reservedAnchors: input.reservedAnchors,
      anchor: { section: candidate.anchor.section, paragraph: candidate.anchor.paragraph },
    });
    await assertCandidatePreimage(candidate, current, input.command.afterText, {
      allowDocumentShaMismatch: true,
      allowLengthMismatch: true,
    });
    return await mutateExactParagraph({
      rhwp: input.rhwp,
      document,
      format: input.format,
      candidate,
      replacement: candidate.beforeText,
      operation: "undo",
      beforeDocumentSha256,
    });
  } finally {
    document.free();
  }
}

async function mutateExactParagraph(input: {
  rhwp: RhwpModule;
  document: RhwpDocument;
  format: RhwpDocumentFormat;
  candidate: DocumentEditCandidate;
  replacement: string;
  operation: "apply" | "undo";
  beforeDocumentSha256: string;
}): Promise<VerifiedEditResult> {
  const beforeManifest = await buildDocumentAgentSemanticManifest(input.document);
  const charShapeId = nonnegativeId(input.candidate.formatSnapshot.charProperties.charShapeId, "charShapeId");
  const paraShapeId = nonnegativeId(
    input.candidate.formatSnapshot.paragraphProperties.paraShapeId,
    "paraShapeId",
  );
  const snapshotId = input.document.saveSnapshot();
  if (!Number.isInteger(snapshotId) || snapshotId < 0) throw new Error("RHWP document snapshot을 만들지 못했습니다.");
  let batchStarted = false;
  let mutationCompleted = false;
  try {
    assertOkResult(input.document.beginBatch(), "beginBatch");
    batchStarted = true;
    try {
      const currentLength = input.document.getParagraphLength(
        input.candidate.anchor.section,
        input.candidate.anchor.paragraph,
      );
      assertOkResult(input.document.replaceText(
        input.candidate.anchor.section,
        input.candidate.anchor.paragraph,
        0,
        currentLength,
        input.replacement,
      ), "replaceText");
      const replacementLength = input.document.getParagraphLength(
        input.candidate.anchor.section,
        input.candidate.anchor.paragraph,
      );
      if (!Number.isInteger(replacementLength) || replacementLength < 1 || replacementLength > 4_000) {
        throw new Error("RHWP 치환 뒤 target 문단 길이가 허용 범위를 벗어났습니다.");
      }
      assertOkResult(input.document.setCharShapeId(
        input.candidate.anchor.section,
        input.candidate.anchor.paragraph,
        0,
        replacementLength,
        charShapeId,
      ), "setCharShapeId");
      assertOkResult(input.document.setParaShapeId(
        input.candidate.anchor.section,
        input.candidate.anchor.paragraph,
        paraShapeId,
      ), "setParaShapeId");
    } finally {
      if (batchStarted) {
        const endBatchResult = input.document.endBatch();
        batchStarted = false;
        assertOkResult(endBatchResult, "endBatch");
      }
    }

    const afterManifest = await buildDocumentAgentSemanticManifest(input.document);
    assertDocumentAgentTargetMutation({
      before: beforeManifest,
      after: afterManifest,
      target: input.candidate.anchor,
      expectedTextSha256: await sha256Hex(input.replacement),
      expectedFormatSha256: input.candidate.formatSha256,
    });
    const verification = exportVerifiedRhwpDocument({
      rhwp: input.rhwp,
      document: input.document,
      format: input.format,
    });
    const reopened = new input.rhwp.HwpDocument(verification.bytes);
    try {
      const reopenedManifest = await buildDocumentAgentSemanticManifest(reopened);
      assertDocumentAgentManifestsEqual(
        afterManifest,
        reopenedManifest,
        `AI ${input.operation} export/reopen semantic manifest가 달라졌습니다.`,
      );
    } finally {
      reopened.free();
    }
    input.document.discardSnapshot(snapshotId);
    mutationCompleted = true;
    return {
      operation: input.operation,
      bytes: verification.bytes,
      format: input.format,
      beforeManifest,
      afterManifest,
      beforeDocumentSha256: input.beforeDocumentSha256,
      afterDocumentSha256: await sha256Hex(verification.bytes),
    };
  } catch (error) {
    const recoveryErrors: unknown[] = [error];
    if (batchStarted) {
      try {
        input.document.endBatch();
      } catch (batchError) {
        recoveryErrors.push(batchError);
      }
    }
    try {
      assertOkResult(input.document.restoreSnapshot(snapshotId), "restoreSnapshot");
    } catch (restoreError) {
      recoveryErrors.push(restoreError);
    }
    try {
      input.document.discardSnapshot(snapshotId);
    } catch (discardError) {
      recoveryErrors.push(discardError);
    }
    if (recoveryErrors.length === 1) throw error;
    throw new AggregateError(recoveryErrors, "RHWP AI transaction 복구 중 추가 오류가 발생했습니다.");
  } finally {
    if (!mutationCompleted && batchStarted) {
      // catch에서 endBatch를 시도한 뒤에도 플래그가 남는 경우 재호출하지 않는다.
      batchStarted = false;
    }
  }
}

async function assertCandidatePreimage(
  expected: DocumentEditCandidate,
  actual: DocumentEditCandidate | null,
  expectedText: string,
  options: { allowDocumentShaMismatch?: boolean; allowLengthMismatch?: boolean } = {},
): Promise<void> {
  if (!actual) throw new Error("AI 문서 target이 현재 문서에서 더 이상 안전 후보가 아닙니다.");
  const expectedTextSha256 = await sha256Hex(expectedText);
  if (
    actual.beforeText !== expectedText
    || actual.beforeSha256 !== expectedTextSha256
    || actual.sourceKey !== expected.sourceKey
    || actual.reservedAnchorsSha256 !== expected.reservedAnchorsSha256
    || actual.formatSha256 !== expected.formatSha256
    || actual.adjacentContextSha256 !== expected.adjacentContextSha256
    || actual.studioCommandEvidence.formatSha256 !== expected.studioCommandEvidence.formatSha256
    || actual.studioCommandEvidence.adjacentContextSha256
      !== expected.studioCommandEvidence.adjacentContextSha256
    || actual.anchor.section !== expected.anchor.section
    || actual.anchor.paragraph !== expected.anchor.paragraph
    || actual.anchor.charOffset !== expected.anchor.charOffset
    || (!options.allowLengthMismatch && actual.anchor.length !== expected.anchor.length)
    || actual.location.page !== expected.location.page
    || (!options.allowDocumentShaMismatch && actual.documentSha256 !== expected.documentSha256)
    || (!options.allowDocumentShaMismatch && actual.candidateId !== expected.candidateId)
  ) {
    throw new Error("AI 문서 target의 before/style/context exact preimage가 달라졌습니다.");
  }
}

function nonnegativeId(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`RHWP ${label}가 nonnegative integer가 아닙니다.`);
  }
  return value as number;
}

function assertOkResult(value: string, operation: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`RHWP ${operation} 결과 JSON을 해석하지 못했습니다.`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
    throw new Error(`RHWP ${operation}이 성공하지 못했습니다.`);
  }
}

export interface DocumentAgentStudioEditor {
  loadFile(
    bytes: Uint8Array,
    filename: string,
    options?: { suppressDialogs?: boolean },
  ): Promise<unknown>;
}

export type StudioReloadResult =
  | { kind: "committed" }
  | { kind: "rolled_back"; error: unknown };

/** Studio reload 성공 및 재-export 검증 뒤에만 working refs를 전진시킨다. */
export async function reloadVerifiedDocumentAgentBytes(input: {
  editor: DocumentAgentStudioEditor;
  beforeBytes: Uint8Array;
  afterBytes: Uint8Array;
  filename: string;
  verifyLoadedBytes(expected: Uint8Array): Promise<void>;
  commitWorkingRefs(bytes: Uint8Array): void;
}): Promise<StudioReloadResult> {
  try {
    await input.editor.loadFile(input.afterBytes.slice(), input.filename, {
      suppressDialogs: true,
    });
    await input.verifyLoadedBytes(input.afterBytes);
    input.commitWorkingRefs(input.afterBytes);
    return { kind: "committed" };
  } catch (error) {
    try {
      await input.editor.loadFile(input.beforeBytes.slice(), input.filename, {
        suppressDialogs: true,
      });
      await input.verifyLoadedBytes(input.beforeBytes);
      return { kind: "rolled_back", error };
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "AI 문서 reload 실패 뒤 before 문서 복구도 실패했습니다.",
      );
    }
  }
}
