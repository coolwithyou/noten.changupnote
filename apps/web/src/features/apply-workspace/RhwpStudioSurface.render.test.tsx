import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sha256Hex } from "@/lib/rhwp/documentAgentContract";
import type { StudioDocumentChangedEventV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";
import type { RhwpDocumentChange, RhwpStudioSaveProtocol } from "@/lib/rhwp/studioSaveProtocol";
import { StudioSnapshotPersistenceError } from "@/lib/rhwp/studioSnapshots";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const {
  isDefinitiveStudioSnapshotRejection,
  isStudioEditorInteractionBlocked,
  RhwpStudioSurface,
  restoreProfileAutofillAppliedEditor,
  subscribeStudioDocumentChanges,
} = await import("./RhwpStudioSurface");

assert.equal(
  isStudioEditorInteractionBlocked({
    status: "ready",
    saving: false,
    documentActionsBlocked: true,
  }),
  true,
  "저장 결과가 불확정이거나 agent 작업 중이면 iframe 키보드 입력도 잠가야 합니다.",
);
assert.equal(
  isStudioEditorInteractionBlocked({
    status: "ready",
    saving: true,
    documentActionsBlocked: false,
  }),
  true,
  "저장 중에는 이미 포커스된 iframe 입력도 잠가야 합니다.",
);
assert.equal(
  isStudioEditorInteractionBlocked({
    status: "loading",
    allowEditorInteraction: true,
    saving: false,
    documentActionsBlocked: false,
  }),
  false,
  "폰트 준비처럼 기존에 상호작용을 허용한 loading 단계는 잠그면 안 됩니다.",
);

const html = renderToStaticMarkup(
  <RhwpStudioSurface
    transport={{ mode: "persistent", draftId: "00000000-0000-4000-8000-000000000001" }}
    answers={{}}
    quickFields={[]}
    connectedFields={[]}
    manualAnchors={[]}
    duplicateLabels={new Set()}
    workingDocument={null}
    headMaterializedAnswers={{}}
    activeTask={null}
    onSaved={() => undefined}
  />,
);

assert.ok(html.includes("지금 저장"), "Studio 작업본을 서버에 저장하는 버튼이 보여야 합니다.");
assert.ok(html.includes("편집본 다운로드"), "persistent Studio도 현재 검증 편집본 다운로드를 제공해야 합니다.");
assert.ok(
  html.includes("수정 후 직접 저장이 필요해요"),
  "legacy Studio에서는 자동 저장을 가장하지 않고 수동 저장 필요 상태를 보여야 합니다.",
);
assert.ok(
  html.includes("저장하고 빠른 작성으로"),
  "저장 후 빠른 작성으로 복귀하는 별도 버튼이 보여야 합니다.",
);

const localHtml = renderToStaticMarkup(
  <RhwpStudioSurface
    transport={{
      mode: "local_preview",
      sourceKey: "virtual:grant:biz:document",
      sourceUrl: "/api/web/grants/grant/virtual-source-file?biz=0000000001&document=application",
    }}
    answers={{}}
    quickFields={[]}
    connectedFields={[]}
    manualAnchors={[]}
    duplicateLabels={new Set()}
    workingDocument={null}
    headMaterializedAnswers={{}}
    activeTask={null}
    onSaved={() => undefined}
  />,
);
assert.ok(localHtml.includes("서버에는 저장되지 않습니다"), "가상 기업 편집의 비영속 경계를 안내해야 합니다.");
assert.ok(localHtml.includes("이 탭에 반영"), "가상 기업 편집본은 브라우저 탭에만 반영해야 합니다.");
assert.ok(localHtml.includes("편집본 다운로드"), "가상 기업 RHWP 편집본 다운로드를 제공해야 합니다.");
assert.equal(localHtml.includes("지금 저장"), false, "가상 기업 편집에서 서버 저장 표현을 노출하면 안 됩니다.");

const fieldAwareHtml = renderToStaticMarkup(
  <RhwpStudioSurface
    transport={{ mode: "persistent", draftId: "00000000-0000-4000-8000-000000000001" }}
    answers={{}}
    quickFields={[]}
    connectedFields={[]}
    manualAnchors={[]}
    duplicateLabels={new Set()}
    workingDocument={null}
    headMaterializedAnswers={{}}
    activeTask={null}
    documentAgentAvailable
    presentation="field_aware"
    onSaved={() => undefined}
  />,
);
assert.equal(fieldAwareHtml.includes("지금 저장"), false, "통합 화면의 저장 버튼은 AI 사이드바로 이동해야 합니다.");
assert.equal(fieldAwareHtml.includes("편집본 다운로드"), false, "통합 화면의 다운로드 버튼은 AI 사이드바로 이동해야 합니다.");
assert.equal(fieldAwareHtml.includes("AI 작성 제안"), false, "일반 문단 에이전트를 필드 에이전트 CTA로 노출하면 안 됩니다.");
assert.equal(fieldAwareHtml.includes("저장하고 빠른 작성으로"), false, "통합 화면은 quick-first 복귀 동작을 제공하면 안 됩니다.");

const documentGuidedHtml = renderToStaticMarkup(
  <RhwpStudioSurface
    transport={{ mode: "persistent", draftId: "00000000-0000-4000-8000-000000000001" }}
    answers={{}}
    quickFields={[]}
    connectedFields={[]}
    manualAnchors={[]}
    duplicateLabels={new Set()}
    workingDocument={null}
    headMaterializedAnswers={{}}
    activeTask={null}
    documentAgentAvailable
    presentation="document_guided"
    onSaved={() => undefined}
  />,
);
assert.ok(documentGuidedHtml.includes("AI 작성 가이드"), "필드가 없는 RHWP도 우측 작성 가이드를 보여야 합니다.");
assert.ok(documentGuidedHtml.includes("문서 직접 편집기"), "작성 가이드와 RHWP 편집기를 동시에 렌더링해야 합니다.");
assert.ok(documentGuidedHtml.includes("지금 저장") && documentGuidedHtml.includes("편집본 다운로드"));
assert.equal(documentGuidedHtml.includes("빠른 작성"), false, "문서 작성 가이드 화면에 quick-first 카피가 남으면 안 됩니다.");

function saveProtocol(input: {
  supportsChangeEvents: boolean;
  subscribe: RhwpStudioSaveProtocol["subscribeDocumentChanged"];
}): RhwpStudioSaveProtocol {
  return {
    supportsChangeEvents: input.supportsChangeEvents,
    supportsSnapshotExport: false,
    getDirtyState: () => null,
    exportSnapshot: () => null,
    subscribeDocumentChanged: input.subscribe,
  };
}

let saveListener: ((change: RhwpDocumentChange) => void) | null = null;
let saveCleanupCount = 0;
let nativeSubscriptionCount = 0;
const modernChanges: number[] = [];
const modernCleanup = subscribeStudioDocumentChanges({
  saveProtocol: saveProtocol({
    supportsChangeEvents: true,
    subscribe: (listener) => {
      saveListener = listener;
      return () => {
        saveCleanupCount += 1;
      };
    },
  }),
  fieldAgentProtocol: {
    onDocumentChanged: () => {
      nativeSubscriptionCount += 1;
      return () => undefined;
    },
  },
  onDocumentChanged: (change) => modernChanges.push(change.changeSeq),
});
assert.ok(saveListener);
(saveListener as (change: RhwpDocumentChange) => void)({
  documentEpoch: 1,
  changeSeq: 1,
  dirty: false,
});
(saveListener as (change: RhwpDocumentChange) => void)({
  documentEpoch: 1,
  changeSeq: 2,
  dirty: true,
});
assert.deepEqual(modernChanges, [2], "save protocol에서는 dirty 변경만 전달해야 합니다.");
assert.equal(nativeSubscriptionCount, 0, "save protocol 구독이 있으면 native fallback을 중복 연결하면 안 됩니다.");
modernCleanup?.();
assert.equal(saveCleanupCount, 1, "선택한 save protocol cleanup만 한 번 실행해야 합니다.");

let nativeListener: ((change: StudioDocumentChangedEventV1) => void) | null = null;
let nativeCleanupCount = 0;
let latestChangeSeq: number | null = null;
let legacySaveSeq = 0;
let automaticUndo: { appliedChangeSeq: number } | null = { appliedChangeSeq: 0 };
const legacyCleanup = subscribeStudioDocumentChanges({
  saveProtocol: saveProtocol({ supportsChangeEvents: false, subscribe: () => null }),
  fieldAgentProtocol: {
    onDocumentChanged: (listener) => {
      nativeListener = listener;
      return () => {
        nativeCleanupCount += 1;
        nativeListener = null;
      };
    },
  },
  onDocumentChanged: (change) => {
    automaticUndo = null;
    latestChangeSeq = change.changeSeq;
    legacySaveSeq = Math.max(legacySaveSeq, change.changeSeq);
  },
});
assert.ok(nativeListener, "legacy save protocol에서는 native field event를 fallback으로 구독해야 합니다.");
const emitNativeChange = (changeSeq: number) => {
  nativeListener?.({
    schemaVersion: 1,
    reason: "field_agent_apply",
    documentEpoch: 1,
    changeSeq,
    commandId: `command-${changeSeq}`,
  });
};
emitNativeChange(1);
emitNativeChange(2);
emitNativeChange(3);
assert.equal(latestChangeSeq, 3, "자동입력 batch의 마지막 native sequence를 유지해야 합니다.");
assert.equal(legacySaveSeq, 3, "legacy 저장 idempotency counter도 관측한 native sequence까지 전진해야 합니다.");
automaticUndo = { appliedChangeSeq: 3 };
assert.equal(
  latestChangeSeq === automaticUndo.appliedChangeSeq,
  true,
  "batch 이벤트 처리 뒤 등록한 자동입력 Undo는 마지막 sequence와 일치해야 합니다.",
);
emitNativeChange(4);
assert.equal(automaticUndo, null, "다음 수동 일괄입력이나 AI field command는 기존 자동입력 Undo를 무효화해야 합니다.");
assert.equal(legacySaveSeq + 1, 5, "다음 legacy 저장은 이미 쓴 native sequence를 재사용하면 안 됩니다.");
legacyCleanup?.();
assert.equal(nativeCleanupCount, 1, "fallback cleanup은 native 구독만 한 번 해제해야 합니다.");
emitNativeChange(5);
assert.equal(latestChangeSeq, 4, "cleanup 뒤 native 이벤트를 더 받으면 안 됩니다.");

const appliedBytes = new Uint8Array([1, 2, 3, 4]);
const reserializedAppliedBytes = new Uint8Array([9, 2, 3, 4]);
let loadAppliedCount = 0;
let notifySavedCount = 0;
let restoredStateReadCount = 0;
const restoredState = await restoreProfileAutofillAppliedEditor({
  format: "hwp",
  expectedBytes: appliedBytes,
  expectedPageCount: 1,
  isCurrent: () => true,
  async loadApplied() {
    loadAppliedCount += 1;
    return { pageCount: 1 };
  },
  async exportCurrentBytes() {
    return reserializedAppliedBytes;
  },
  async readDocumentState() {
    restoredStateReadCount += 1;
    return {
      schemaVersion: 1,
      format: "hwp",
      documentEpoch: 2,
      changeSeq: 0,
      dirty: false,
      pageCount: 1,
      documentSha256: await sha256Hex(reserializedAppliedBytes),
    };
  },
  async semanticSha256(bytes) {
    return sha256Hex(bytes.slice(1));
  },
  async notifySaved() {
    notifySavedCount += 1;
  },
});
assert.equal(loadAppliedCount, 1, "Undo 중간 실패 시 저장된 적용본을 editor에 복구해야 합니다.");
assert.equal(notifySavedCount, 1, "적용본 복구 뒤 editor dirty 상태를 저장 완료로 정리해야 합니다.");
assert.equal(restoredStateReadCount, 1);
assert.deepEqual(restoredState, {
  schemaVersion: 1,
  format: "hwp",
  documentEpoch: 2,
  changeSeq: 0,
  dirty: false,
  pageCount: 1,
  documentSha256: await sha256Hex(reserializedAppliedBytes),
});

let staleLoadCount = 0;
const staleRecovery = await restoreProfileAutofillAppliedEditor({
  format: "hwp",
  expectedBytes: appliedBytes,
  expectedPageCount: 1,
  isCurrent: () => false,
  async loadApplied() {
    staleLoadCount += 1;
    return { pageCount: 1 };
  },
  async exportCurrentBytes() {
    throw new Error("stale source에서는 문서를 내보내면 안 됩니다.");
  },
  async readDocumentState() {
    throw new Error("stale source에서는 상태를 읽으면 안 됩니다.");
  },
  async semanticSha256() {
    throw new Error("stale source에서는 의미 SHA를 계산하면 안 됩니다.");
  },
  async notifySaved() {
    throw new Error("stale source를 저장 완료 처리하면 안 됩니다.");
  },
});
assert.equal(staleRecovery, null, "문서 전환 뒤에는 이전 적용본을 새 editor에 올리면 안 됩니다.");
assert.equal(staleLoadCount, 0);

let currentAfterLoad = true;
let staleExportCount = 0;
const changedDuringLoadRecovery = await restoreProfileAutofillAppliedEditor({
  format: "hwp",
  expectedBytes: appliedBytes,
  expectedPageCount: 1,
  isCurrent: () => currentAfterLoad,
  async loadApplied() {
    currentAfterLoad = false;
    return { pageCount: 1 };
  },
  async exportCurrentBytes() {
    staleExportCount += 1;
    return appliedBytes;
  },
  async readDocumentState() {
    throw new Error("전환된 source 상태를 읽으면 안 됩니다.");
  },
  async semanticSha256() {
    throw new Error("전환된 source 의미 SHA를 계산하면 안 됩니다.");
  },
  async notifySaved() {
    throw new Error("전환된 source를 저장 완료 처리하면 안 됩니다.");
  },
});
assert.equal(changedDuringLoadRecovery, null, "적용본 load 도중 source가 바뀌면 즉시 복구 반영을 중단해야 합니다.");
assert.equal(staleExportCount, 0, "source 전환 뒤 다음 await 단계로 진행하면 안 됩니다.");

let changedRecoveryNotified = false;
await assert.rejects(
  restoreProfileAutofillAppliedEditor({
    format: "hwp",
    expectedBytes: appliedBytes,
    expectedPageCount: 1,
    isCurrent: () => true,
    async loadApplied() {
      return { pageCount: 1 };
    },
    async exportCurrentBytes() {
      return new Uint8Array([9, 8, 7, 6]);
    },
    async readDocumentState() {
      const bytes = new Uint8Array([9, 8, 7, 6]);
      return {
        schemaVersion: 1,
        format: "hwp",
        documentEpoch: 2,
        changeSeq: 0,
        dirty: false,
        pageCount: 1,
        documentSha256: await sha256Hex(bytes),
      };
    },
    async semanticSha256(bytes) {
      return sha256Hex(bytes.slice(1));
    },
    async notifySaved() {
      changedRecoveryNotified = true;
    },
  }),
  /문서 내용 또는 서식이 저장된 적용본과 다릅니다/,
);
assert.equal(changedRecoveryNotified, false, "의미가 다른 복구본을 저장 완료로 표시하면 안 됩니다.");

assert.equal(
  isDefinitiveStudioSnapshotRejection(
    new StudioSnapshotPersistenceError("revision_conflict", "head가 변경되었습니다.", 409, "revision"),
  ),
  true,
  "파싱된 4xx 거절은 서버 미commit으로 분류해야 합니다.",
);
assert.equal(
  isDefinitiveStudioSnapshotRejection(
    new StudioSnapshotPersistenceError("studio_snapshot_save_failed", "서버 오류", 500, null),
  ),
  false,
  "파싱된 5xx도 commit 여부가 불확실하므로 로컬 역변경하면 안 됩니다.",
);
assert.equal(
  isDefinitiveStudioSnapshotRejection(new TypeError("fetch failed")),
  false,
  "network/JSON 오류는 서버 commit 여부가 불확실합니다.",
);

console.log("RhwpStudioSurface dual save actions render test passed");
