"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, FilePenLine, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { RhwpFieldAnchor } from "@/lib/rhwp/fieldAnchors";
import { exportVerifiedEditorDocument, RHWP_STUDIO_URL } from "@/lib/rhwp/editorClient";
import {
  initialStudioSaveState,
  isStudioSaveInFlight,
  reduceStudioSaveState,
} from "@/lib/rhwp/studioSaveState";
import { resolveRhwpStudioSaveProtocol, type RhwpStudioSaveProtocol } from "@/lib/rhwp/studioSaveProtocol";
import { persistStudioSnapshot } from "@/lib/rhwp/studioSnapshots";
import { prepareRhwpWorkingDocument, type RhwpWorkingDocument } from "@/lib/rhwp/workingDocument";
import type { DocumentAuthoringTask } from "./documentAuthoring";
import { StudioSaveIndicator } from "./StudioSaveIndicator";

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;

export interface RhwpStudioSurfaceHandle {
  saveAndReturn(): Promise<void>;
}

type StudioState =
  | { status: "loading"; message: string; allowEditorInteraction?: boolean }
  | { status: "ready"; pageCount: number; skipped: RhwpWorkingDocument["skipped"] }
  | { status: "error"; message: string };

type StudioSaveIntent = "auto" | "stay" | "return";

export const RhwpStudioSurface = forwardRef<RhwpStudioSurfaceHandle, {
  draftId: string;
  answers: DraftFieldAnswers;
  quickFields: readonly ConnectedDocumentField[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels: ReadonlySet<string>;
  workingDocument: RhwpWorkingDocument | null;
  headMaterializedAnswers: Record<string, string>;
  activeTask: DocumentAuthoringTask | null;
  onSaved: (
    document: RhwpWorkingDocument,
    taskFieldId: string | null,
    returnToQuick: boolean,
  ) => void;
}>(({
  draftId,
  answers,
  quickFields,
  manualAnchors,
  duplicateLabels,
  workingDocument,
  headMaterializedAnswers,
  activeTask,
  onSaved,
}, ref) => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StudioState>({ status: "loading", message: "작업 문서를 준비하고 있어요." });
  const [saveState, dispatchSave] = useReducer(reduceStudioSaveState, initialStudioSaveState);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const saveProtocolRef = useRef<RhwpStudioSaveProtocol | null>(null);
  const preparedRef = useRef<RhwpWorkingDocument | null>(null);
  const onSavedRef = useRef(onSaved);
  const activeTaskFieldIdRef = useRef(activeTask?.fieldId ?? null);
  // 임시 저장으로 부모 workingDocument가 갱신돼도 편집기를 다시 열지 않는다. 이 ref는 빠른
  // 작성으로 전환해 화면을 숨긴 동안에도 유지되는 현재 Studio 세션의 최신 검증 스냅샷이다.
  const sessionDocumentRef = useRef<RhwpWorkingDocument | null>(workingDocument);
  const initializationInputRef = useRef({
    answers,
    quickFields,
    manualAnchors,
    duplicateLabels,
    headMaterializedAnswers,
  });
  const saveInFlightRef = useRef(false);
  const autosaveIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutosaveRef = useRef<(changeSeq: number) => void>(() => undefined);
  const flushAutosaveRef = useRef<() => void>(() => undefined);
  const documentEpochRef = useRef(0);
  const latestChangeSeqRef = useRef<number | null>(null);
  const legacySaveSeqRef = useRef(0);
  const studioSessionIdRef = useRef<string | null>(null);
  if (!studioSessionIdRef.current) studioSessionIdRef.current = crypto.randomUUID();
  const requestSeq = useRef(0);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    activeTaskFieldIdRef.current = activeTask?.fieldId ?? null;
  }, [activeTask?.fieldId]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let disposed = false;
    let unsubscribeDocumentChanged: (() => void) | null = null;
    const initialize = async () => {
      const initializationInput = initializationInputRef.current;
      setState({ status: "loading", message: "확정한 빠른 작성 값을 원본 문서에 반영하고 있어요." });
      const prepared = await prepareRhwpWorkingDocument({
        draftId,
        answers: initializationInput.answers,
        connectedFields: initializationInput.quickFields,
        manualAnchors: initializationInput.manualAnchors,
        duplicateLabels: initializationInput.duplicateLabels,
        base: sessionDocumentRef.current,
        baseMaterializedAnswers: initializationInput.headMaterializedAnswers,
      });
      if (disposed || requestSeq.current !== seq) return;
      preparedRef.current = prepared;
      setState({ status: "loading", message: "자가 호스팅 rhwp Studio를 불러오고 있어요." });
      const { createEditor } = await import("@rhwp/editor");
      if (!containerRef.current) throw new Error("문서 편집 화면을 준비하지 못했습니다.");
      const editor = await createEditor(containerRef.current, {
        studioUrl: RHWP_STUDIO_URL,
        requestTimeoutMs: 180_000,
      });
      if (disposed || requestSeq.current !== seq) {
        editor.destroy();
        return;
      }
      editorRef.current = editor;
      // 첫 로드에서 브라우저 로컬 글꼴 확인이 필요할 수 있다. 이 단계에서는 부모 오버레이가
      // iframe 클릭을 가로막으면 Promise가 끝나지 않으므로 편집기를 노출한다.
      setState({
        status: "loading",
        message: "처음 한 번 문서 확인창은 ‘그대로 보기’, 글꼴 확인창은 ‘로컬 글꼴 감지 (권장)’를 선택해 주세요.",
        allowEditorInteraction: true,
      });
      const result = await editor.loadFile(prepared.bytes.slice(), prepared.filename);
      if (disposed || requestSeq.current !== seq) return;
      const saveProtocol = resolveRhwpStudioSaveProtocol(editor);
      saveProtocolRef.current = saveProtocol;
      const dirtyState = saveProtocol.getDirtyState ? await saveProtocol.getDirtyState() : null;
      if (disposed || requestSeq.current !== seq) return;
      documentEpochRef.current = dirtyState?.documentEpoch ?? 0;
      latestChangeSeqRef.current = dirtyState?.changeSeq ?? null;
      dispatchSave({
        type: "loaded",
        supportsChangeEvents: saveProtocol.supportsChangeEvents,
        revisionId: prepared.revisionId,
        savedAt: prepared.serverSavedAt,
        ...(dirtyState ? { changeSeq: dirtyState.changeSeq } : {}),
      });
      unsubscribeDocumentChanged = saveProtocol.subscribeDocumentChanged((change) => {
        if (disposed || requestSeq.current !== seq || !change.dirty) return;
        documentEpochRef.current = change.documentEpoch;
        latestChangeSeqRef.current = change.changeSeq;
        dispatchSave({ type: "changed", changeSeq: change.changeSeq });
        scheduleAutosaveRef.current(change.changeSeq);
      });
      setState({ status: "ready", pageCount: result.pageCount, skipped: prepared.skipped });
    };
    void initialize().catch((caught) => {
      if (disposed || requestSeq.current !== seq) return;
      setState({ status: "error", message: caught instanceof Error ? caught.message : "문서 편집기를 열지 못했습니다." });
    });
    return () => {
      disposed = true;
      requestSeq.current += 1;
      unsubscribeDocumentChanged?.();
      editorRef.current?.destroy();
      editorRef.current = null;
      saveProtocolRef.current = null;
      preparedRef.current = null;
    };
    // Studio는 현재 draft에서 한 번만 생성한다. 빠른 작성 값이 바뀌었다고 iframe을 파괴해
    // 재로드하면 글꼴 권한 확인이 매번 반복된다. 최신 빠른 작성 값은 최종 저장에서 delta로 합친다.
  }, [attempt, draftId]);

  const save = useCallback(async (intent: StudioSaveIntent) => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (
      !editor
      || !prepared
      || saveInFlightRef.current
      || state.status === "loading"
      || state.status === "error"
    ) return;
    saveInFlightRef.current = true;
    if (autosaveIdleTimerRef.current) clearTimeout(autosaveIdleTimerRef.current);
    if (autosaveMaxTimerRef.current) clearTimeout(autosaveMaxTimerRef.current);
    autosaveIdleTimerRef.current = null;
    autosaveMaxTimerRef.current = null;
    let tabSnapshot: RhwpWorkingDocument | null = null;
    const supportsChangeEvents = saveProtocolRef.current?.supportsChangeEvents ?? false;
    // Legacy host는 dirty/changeSeq 이벤트가 없으므로 성공 ACK 전에는 같은 순번을 재사용한다.
    // 서버가 저장했지만 응답만 유실된 경우 같은 bytes+순번 재시도가 기존 revision을 복구한다.
    const savedSeq = latestChangeSeqRef.current ?? legacySaveSeqRef.current + 1;
    dispatchSave({ type: "save-started", changeSeq: savedSeq, phase: "exporting" });
    try {
      const pageCount = await editor.pageCount();
      const bytes = await exportVerifiedEditorDocument(editor, prepared.format);
      tabSnapshot = {
        ...prepared,
        bytes,
        revisionId: prepared.revisionId,
        serverSavedAt: null,
      };
      preparedRef.current = tabSnapshot;
      sessionDocumentRef.current = tabSnapshot;
      dispatchSave({ type: "save-phase", phase: "uploading" });
      const persisted = await persistStudioSnapshot({
        draftId,
        bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: prepared.revisionId,
        documentEpoch: documentEpochRef.current,
        changeSeq: savedSeq,
        origin: intent === "auto" ? "studio_autosave" : "studio_manual",
        materializedAnswers: tabSnapshot.materializedAnswers,
        verification: {
          client: "rhwp-core-reopen",
          verified: true,
          supportsChangeEvents,
        },
      });
      const serverSnapshot: RhwpWorkingDocument = {
        ...tabSnapshot,
        revisionId: persisted.revisionId,
        serverSavedAt: persisted.savedAt,
      };
      preparedRef.current = serverSnapshot;
      sessionDocumentRef.current = serverSnapshot;
      if (!supportsChangeEvents) legacySaveSeqRef.current = savedSeq;
      onSavedRef.current(serverSnapshot, activeTaskFieldIdRef.current, intent === "return");
      dispatchSave({
        type: "save-succeeded",
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        savedSeq,
        currentSeq: latestChangeSeqRef.current,
        supportsChangeEvents,
      });
      if (intent === "stay") {
        toast.success("Studio 작업본을 서버에 저장했습니다.");
      } else if (intent === "return") {
        toast.success("Studio 작업본을 서버에 저장하고 빠른 작성으로 돌아갑니다.");
      }
      const currentSeq = latestChangeSeqRef.current;
      if (supportsChangeEvents && currentSeq !== null && currentSeq > savedSeq) {
        scheduleAutosaveRef.current(currentSeq);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Studio 편집본을 저장하지 못했습니다.";
      if (tabSnapshot) {
        preparedRef.current = tabSnapshot;
        sessionDocumentRef.current = tabSnapshot;
        onSavedRef.current(tabSnapshot, activeTaskFieldIdRef.current, false);
      }
      dispatchSave({
        type: "save-failed",
        changeSeq: savedSeq,
        message,
        hasTabSnapshot: Boolean(tabSnapshot),
      });
      toast.error(message);
    } finally {
      saveInFlightRef.current = false;
    }
  }, [draftId, state.status]);

  useEffect(() => {
    function clearAutosaveTimers() {
      if (autosaveIdleTimerRef.current) clearTimeout(autosaveIdleTimerRef.current);
      if (autosaveMaxTimerRef.current) clearTimeout(autosaveMaxTimerRef.current);
      autosaveIdleTimerRef.current = null;
      autosaveMaxTimerRef.current = null;
    }

    flushAutosaveRef.current = () => {
      clearAutosaveTimers();
      void save("auto");
    };
    scheduleAutosaveRef.current = (changeSeq) => {
      if (!saveProtocolRef.current?.supportsChangeEvents) return;
      if (autosaveIdleTimerRef.current) clearTimeout(autosaveIdleTimerRef.current);
      const dueAt = Date.now() + 10_000;
      dispatchSave({ type: "scheduled", changeSeq, dueAt });
      autosaveIdleTimerRef.current = setTimeout(() => {
        flushAutosaveRef.current();
      }, 10_000);
      if (!autosaveMaxTimerRef.current) {
        autosaveMaxTimerRef.current = setTimeout(() => {
          flushAutosaveRef.current();
        }, 60_000);
      }
    };

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "hidden"
        && (autosaveIdleTimerRef.current || autosaveMaxTimerRef.current)
      ) {
        flushAutosaveRef.current();
      }
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        saveState.kind !== "dirty"
        && saveState.kind !== "scheduled"
        && saveState.kind !== "saving"
        && saveState.kind !== "tab-only"
        && saveState.kind !== "error"
        && !autosaveIdleTimerRef.current
        && !autosaveMaxTimerRef.current
        && !saveInFlightRef.current
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      clearAutosaveTimers();
      scheduleAutosaveRef.current = () => undefined;
      flushAutosaveRef.current = () => undefined;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [draftId, save, saveState.kind]);

  const saveAndReturn = useCallback(async () => {
    await save("return");
  }, [save]);

  useImperativeHandle(ref, () => ({ saveAndReturn }), [saveAndReturn]);

  const saving = isStudioSaveInFlight(saveState);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-studio/30 bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-studio/35 bg-studio-soft text-studio">
              <FilePenLine data-icon="inline-start" aria-hidden />
              문서 직접 편집
            </Badge>
            {activeTask ? <strong className="truncate text-sm">현재 과제: {activeTask.label}</strong> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            전체 문서를 직접 편집할 수 있어요. 지금 저장하면 검증된 작업본을 서버에 보관합니다.
          </p>
          <StudioSaveIndicator state={saveState} className="mt-1" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void save("stay")}
            disabled={state.status !== "ready" || saving}
          >
            {saving
              ? <Spinner data-icon="inline-start" />
              : <Save data-icon="inline-start" aria-hidden />}
            {saving ? "저장 중…" : saveState.kind === "error" ? "서버 저장 재시도" : "지금 저장"}
          </Button>
          <Button
            type="button"
            onClick={() => void saveAndReturn()}
            disabled={state.status !== "ready" || saving}
          >
            {saving
              ? <Spinner data-icon="inline-start" />
              : <ArrowLeft data-icon="inline-start" aria-hidden />}
            {saving
              ? "서버에 저장 중…"
              : "저장하고 빠른 작성으로"}
          </Button>
        </div>
      </div>

      {state.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>문서 편집기를 열거나 저장하지 못했습니다.</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw data-icon="inline-start" aria-hidden />
              다시 시도
            </Button>
          </div>
        </Alert>
      ) : null}

      {saveState.kind === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Studio 작업본을 서버에 저장하지 못했습니다.</AlertTitle>
          <AlertDescription>
            {saveState.message}
            {saveState.hasTabSnapshot
              ? " 검증한 작업본은 현재 브라우저 탭에 남아 있지만 새로고침하면 사라질 수 있습니다."
              : ""}
          </AlertDescription>
          <div className="mt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void save("stay")}
              disabled={saving || state.status !== "ready"}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              서버 저장 다시 시도
            </Button>
          </div>
        </Alert>
      ) : null}

      {state.status === "ready" && state.skipped.length > 0 ? (
        <Alert className="border-warning-strong/30 bg-warning-strong-soft">
          <AlertTitle>빠른 작성 값 {state.skipped.length.toLocaleString("ko-KR")}개는 자동 반영하지 않았어요.</AlertTitle>
          <AlertDescription>
            Studio에서 직접 확인해 주세요: {state.skipped.map((entry) => entry.label).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="relative min-h-[68dvh] flex-1 overflow-hidden rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-standard)]">
        {state.status === "loading" && state.allowEditorInteraction ? (
          <div className="pointer-events-none absolute top-3 left-1/2 z-10 w-[min(92%,42rem)] -translate-x-1/2 rounded-[var(--radius-lg)] border border-warning-strong/30 bg-card/95 px-3 py-2 text-center text-xs text-muted-foreground shadow-[var(--shadow-subtle)] backdrop-blur-sm">
            {state.message}
          </div>
        ) : state.status === "loading" || saving ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-[var(--shadow-subtle)]">
              <Spinner className="text-primary" />
              {state.status === "loading"
                ? state.message
                : "작업본을 검증해 서버에 저장하고 있어요."}
            </div>
          </div>
        ) : state.status === "ready" ? (
          <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full border bg-card/95 px-2.5 py-1 text-xs text-muted-foreground shadow-[var(--shadow-subtle)]">
            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
            {state.pageCount.toLocaleString("ko-KR")}쪽 열림
          </div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-[68dvh] w-full" aria-label="rhwp 문서 직접 편집기" />
      </div>
    </div>
  );
});

RhwpStudioSurface.displayName = "RhwpStudioSurface";
