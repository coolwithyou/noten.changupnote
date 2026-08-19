import assert from "node:assert/strict";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import { sha256Hex, type DocumentEditCandidate } from "./documentAgentContract";
import { extractDocumentEditCandidates } from "./documentAgentCandidates";
import { applyDocumentAgentEdit, undoDocumentAgentEdit } from "./documentAgentTransaction";
import {
  createStudioCommandDocumentAgentTransaction,
  StudioDocumentAgentVerificationError,
} from "./studioCommandDocumentAgentTransaction";
import type {
  StudioApplyTextCommandV1,
  StudioDocumentAgentProtocol,
  StudioDocumentChangedEventV1,
  StudioRevertTextCommandV1,
  StudioTextCommandReceiptV1,
} from "./studioDocumentAgentProtocol";
import type { RhwpDocument, RhwpDocumentFormat, RhwpModule } from "./client";

const rhwp = await loadDocumentAgentCore();

for (const format of ["hwp", "hwpx"] as const) {
  const fixture = createFixtureBytes(rhwp, format);
  const candidate = await firstCandidate(rhwp, fixture, format);
  const fake = createFakeStudioProtocol({ rhwp, format, bytes: fixture, candidate });
  const transaction = createStudioCommandDocumentAgentTransaction({
    rhwp,
    protocol: fake.protocol,
    exportCurrentBytes: async () => fake.currentBytes(),
    createCommandId: () => `native-${format}`,
  });
  const replacement = "Studio 공개 명령으로 안전하게 바꾼 문단입니다.";
  const applied = await transaction.apply({
    bytes: fixture,
    format,
    reservedAnchors: [],
    command: { schemaVersion: "document-agent-v1", candidate, replacement },
  });
  assert.equal(applied.studioReceipt.commandId, `native-${format}`);
  assert.equal(applied.studioReceipt.operation, "apply");
  assert.equal(applied.afterDocumentSha256, await sha256Hex(fake.currentBytes()));
  assert.equal(applied.focus.focused, true);
  assert.deepEqual(fake.calls.slice(0, 3), ["state", "apply", "focus"]);

  const undone = await transaction.undo({
    bytes: applied.bytes,
    format,
    reservedAnchors: [],
    command: { schemaVersion: "document-agent-v1", candidate, afterText: replacement },
  });
  assert.equal(undone.studioReceipt.operation, "revert");
  assert.equal(undone.studioReceipt.commandId, `native-${format}`);
  assert.equal(undone.afterDocumentSha256, await sha256Hex(fake.currentBytes()));
  assert.deepEqual(fake.events.map((event) => event.reason), ["agent_apply", "agent_revert"]);
  await assert.rejects(
    transaction.undo({
      bytes: undone.bytes,
      format,
      reservedAnchors: [],
      command: { schemaVersion: "document-agent-v1", candidate, afterText: replacement },
    }),
    /가장 최근/u,
  );
}

{
  const format = "hwp" as const;
  const fixture = createFixtureBytes(rhwp, format);
  const candidate = await firstCandidate(rhwp, fixture, format);
  const fake = createFakeStudioProtocol({
    rhwp,
    format,
    bytes: fixture,
    candidate,
    corruptApplyReceiptSha: true,
  });
  const transaction = createStudioCommandDocumentAgentTransaction({
    rhwp,
    protocol: fake.protocol,
    exportCurrentBytes: async () => fake.currentBytes(),
    createCommandId: () => "corrupt-receipt",
  });
  await assert.rejects(
    transaction.apply({
      bytes: fixture,
      format,
      reservedAnchors: [],
      command: {
        schemaVersion: "document-agent-v1",
        candidate,
        replacement: "receipt SHA 불일치 검증 문단입니다.",
      },
    }),
    (error) => error instanceof StudioDocumentAgentVerificationError && error.mutationCommitted,
  );
}

console.log("rhwp Studio native command transaction tests passed");

function createFakeStudioProtocol(input: {
  rhwp: RhwpModule;
  format: RhwpDocumentFormat;
  bytes: Uint8Array;
  candidate: DocumentEditCandidate;
  corruptApplyReceiptSha?: boolean;
}): {
  protocol: StudioDocumentAgentProtocol;
  currentBytes(): Uint8Array;
  calls: string[];
  events: StudioDocumentChangedEventV1[];
} {
  let currentBytes = input.bytes;
  let changeSeq = 0;
  let applyReceipt: StudioTextCommandReceiptV1 | null = null;
  const calls: string[] = [];
  const events: StudioDocumentChangedEventV1[] = [];
  const listeners = new Set<(event: StudioDocumentChangedEventV1) => void>();

  const emit = (event: StudioDocumentChangedEventV1) => {
    events.push(event);
    for (const listener of listeners) listener(event);
  };
  const state = async () => ({
    schemaVersion: 1 as const,
    format: input.format,
    documentEpoch: 1,
    changeSeq,
    dirty: changeSeq > 0,
    pageCount: pageCount(input.rhwp, currentBytes),
    documentSha256: await sha256Hex(currentBytes),
  });

  const protocol: StudioDocumentAgentProtocol = {
    getDocumentState: async () => {
      calls.push("state");
      return state();
    },
    getSelectionContext: async () => ({
      schemaVersion: 1,
      documentEpoch: 1,
      changeSeq,
      page: input.candidate.location.page,
      editable: true,
      collapsed: true,
      target: input.candidate.anchor,
      selectedTextSha256: null,
    }),
    applyTextCommand: async (command: StudioApplyTextCommandV1) => {
      calls.push("apply");
      const beforeState = await state();
      assert.equal(command.expectedDocumentSha256, beforeState.documentSha256);
      assert.equal(command.expectedFormatSha256, input.candidate.studioCommandEvidence.formatSha256);
      assert.equal(
        command.expectedAdjacentContextSha256,
        input.candidate.studioCommandEvidence.adjacentContextSha256,
      );
      const applied = await applyDocumentAgentEdit({
        rhwp: input.rhwp,
        bytes: currentBytes,
        format: input.format,
        reservedAnchors: [],
        command: {
          schemaVersion: "document-agent-v1",
          candidate: input.candidate,
          replacement: command.replacement,
        },
      });
      currentBytes = applied.bytes;
      const beforeChangeSeq = changeSeq;
      changeSeq += 1;
      applyReceipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        operation: "apply",
        documentEpoch: 1,
        beforeChangeSeq,
        afterChangeSeq: changeSeq,
        beforeDocumentSha256: beforeState.documentSha256,
        afterDocumentSha256: input.corruptApplyReceiptSha
          ? "f".repeat(64)
          : await sha256Hex(currentBytes),
        beforeTextSha256: input.candidate.beforeSha256,
        afterTextSha256: await sha256Hex(command.replacement),
        formatSha256: input.candidate.studioCommandEvidence.formatSha256,
        adjacentContextSha256: input.candidate.studioCommandEvidence.adjacentContextSha256,
        pageCountBefore: applied.beforeManifest.pageCount,
        pageCountAfter: applied.afterManifest.pageCount,
        target: input.candidate.anchor,
      };
      emit({
        schemaVersion: 1,
        reason: "agent_apply",
        documentEpoch: 1,
        changeSeq,
        commandId: command.commandId,
      });
      return applyReceipt;
    },
    revertTextCommand: async (command: StudioRevertTextCommandV1) => {
      calls.push("revert");
      assert.ok(applyReceipt);
      assert.equal(command.commandId, applyReceipt.commandId);
      const beforeState = await state();
      const undone = await undoDocumentAgentEdit({
        rhwp: input.rhwp,
        bytes: currentBytes,
        format: input.format,
        reservedAnchors: [],
        command: {
          schemaVersion: "document-agent-v1",
          candidate: input.candidate,
          afterText: textAt(input.rhwp, currentBytes, input.candidate),
        },
      });
      const afterText = textAt(input.rhwp, undone.bytes, input.candidate);
      currentBytes = undone.bytes;
      const beforeChangeSeq = changeSeq;
      changeSeq += 1;
      const receipt: StudioTextCommandReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        operation: "revert",
        documentEpoch: 1,
        beforeChangeSeq,
        afterChangeSeq: changeSeq,
        beforeDocumentSha256: beforeState.documentSha256,
        afterDocumentSha256: await sha256Hex(currentBytes),
        beforeTextSha256: applyReceipt.afterTextSha256,
        afterTextSha256: await sha256Hex(afterText),
        formatSha256: input.candidate.studioCommandEvidence.formatSha256,
        adjacentContextSha256: input.candidate.studioCommandEvidence.adjacentContextSha256,
        pageCountBefore: undone.beforeManifest.pageCount,
        pageCountAfter: undone.afterManifest.pageCount,
        target: input.candidate.anchor,
      };
      emit({
        schemaVersion: 1,
        reason: "agent_revert",
        documentEpoch: 1,
        changeSeq,
        commandId: command.commandId,
      });
      return receipt;
    },
    focusTarget: async (target) => {
      calls.push("focus");
      assert.equal(target.paragraph, input.candidate.anchor.paragraph);
      return { focused: true, page: input.candidate.location.page };
    },
    onDocumentChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const unsubscribe = protocol.onDocumentChanged(() => undefined);
  unsubscribe();
  return { protocol, currentBytes: () => currentBytes, calls, events };
}

async function firstCandidate(
  rhwpModule: RhwpModule,
  bytes: Uint8Array,
  format: RhwpDocumentFormat,
): Promise<DocumentEditCandidate> {
  const document = new rhwpModule.HwpDocument(bytes);
  try {
    const candidates = await extractDocumentEditCandidates({
      document,
      sourceKey: `native-fixture:${format}`,
      documentSha256: await sha256Hex(bytes),
      selectedPage: 1,
      reservedAnchors: [],
    });
    assert.ok(candidates[0]);
    return candidates[0];
  } finally {
    document.free();
  }
}

function createFixtureBytes(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    assertOk(document.insertText(0, 0, 0, "첫 번째 안전 문단입니다."));
    appendParagraph(document, "두 번째 안전 문단을 공개 Studio 명령으로 바꿉니다.");
    appendParagraph(document, "마지막 인접 문단입니다." );
    return format === "hwp" ? document.exportHwp() : document.exportHwpx();
  } finally {
    document.free();
  }
}

function appendParagraph(document: RhwpDocument, text: string): void {
  const current = document.getParagraphCount(0) - 1;
  assertOk(document.splitParagraph(0, current, document.getParagraphLength(0, current)));
  assertOk(document.insertText(0, current + 1, 0, text));
}

function pageCount(rhwpModule: RhwpModule, bytes: Uint8Array): number {
  const document = new rhwpModule.HwpDocument(bytes);
  try {
    return document.pageCount();
  } finally {
    document.free();
  }
}

function textAt(rhwpModule: RhwpModule, bytes: Uint8Array, candidate: DocumentEditCandidate): string {
  const document = new rhwpModule.HwpDocument(bytes);
  try {
    const { section, paragraph } = candidate.anchor;
    return document.getTextRange(section, paragraph, 0, document.getParagraphLength(section, paragraph));
  } finally {
    document.free();
  }
}

function assertOk(value: string): void {
  assert.equal((JSON.parse(value) as { ok?: unknown }).ok, true);
}
