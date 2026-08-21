"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Download, FilePenLine, RefreshCw, Save, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { buildChoiceCellReplacement } from "@/lib/documents/fieldOptions";
import {
  resolveRhwpFieldAnchorsExact,
  type RhwpFieldAnchor,
  type RhwpFieldDescriptor,
} from "@/lib/rhwp/fieldAnchors";
import { downloadBytes, loadRhwp } from "@/lib/rhwp/client";
import {
  extractDocumentEditCandidates,
  reservedAnchorsFromExactResolutions,
} from "@/lib/rhwp/documentAgentCandidates";
import {
  sha256Hex,
  type DocumentAgentReservedAnchor,
  type DocumentEditCandidate,
} from "@/lib/rhwp/documentAgentContract";
import {
  fetchDocumentAgentRuns,
  requestDocumentAgentSuggestions,
  transitionDocumentAgentSuggestion,
} from "@/lib/rhwp/documentAgentApi";
import {
  fetchFieldAgentRuns,
  requestFieldAgentRun,
  transitionFieldAgentRunSuggestion,
} from "@/lib/rhwp/fieldAgentApi";
import {
  createStudioCommandDocumentAgentTransaction,
  StudioDocumentAgentVerificationError,
  type StudioCommandDocumentAgentTransaction,
} from "@/lib/rhwp/studioCommandDocumentAgentTransaction";
import {
  resolveStudioDocumentAgentProtocol,
  resolveStudioFieldAgentProtocol,
  resolveStudioFieldNavigationProtocol,
  resolveStudioFieldSelectionProtocol,
  type StudioFieldNavigationProtocol,
  type StudioFieldTargetV1,
} from "@/lib/rhwp/studioDocumentAgentProtocol";
import {
  resolveStudioFieldBindings,
  type StudioFieldBindingResolution,
} from "@/lib/rhwp/studioFieldBindings";
import {
  createStudioFieldAgentTransaction,
  StudioFieldAgentMutationVerificationError,
  type StudioFieldAgentTransaction,
} from "@/lib/rhwp/studioFieldAgentTransaction";
import {
  matchesStudioFieldDocumentPreimage,
  studioFieldDocumentSemanticSha256,
} from "@/lib/rhwp/studioFieldDocumentManifest";
import {
  exportVerifiedEditorDocument,
  loadEditorFileWithoutDialogs,
  notifyEditorSaved,
  RHWP_STUDIO_URL,
} from "@/lib/rhwp/editorClient";
import {
  initialStudioSaveState,
  isStudioSaveInFlight,
  reduceStudioSaveState,
} from "@/lib/rhwp/studioSaveState";
import { resolveRhwpStudioSaveProtocol, type RhwpStudioSaveProtocol } from "@/lib/rhwp/studioSaveProtocol";
import {
  STUDIO_INITIALIZATION_ATTEMPTS,
  StudioInitializationTimeoutError,
  studioInitializationTimeoutMs,
  studioUrlForInitializationAttempt,
  withStudioInitializationTimeout,
} from "@/lib/rhwp/studioInitialization";
import { persistStudioSnapshot, StudioSnapshotPersistenceError } from "@/lib/rhwp/studioSnapshots";
import { commitStudioSnapshot } from "@/lib/rhwp/studioTransport";
import { cn } from "@/lib/utils";
import {
  prepareRhwpWorkingDocument,
  sourceKeyForTransport,
  type RhwpWorkingDocument,
  type RhwpWorkingDocumentTransport,
} from "@/lib/rhwp/workingDocument";
import type { DocumentAuthoringTask } from "./documentAuthoring";
import type {
  DocumentAgentRunDto,
  DocumentAgentSuggestionDto,
} from "@/lib/server/documents/documentAgentRuns";
import type {
  FieldAgentRunDto,
  FieldAgentSuggestionDto,
} from "@/lib/server/documents/fieldAgentRuns";
import { StudioSaveIndicator } from "./StudioSaveIndicator";
import { DocumentAgentSheet } from "./DocumentAgentSheet";
import {
  initialDocumentAgentUiState,
  reduceDocumentAgentUiState,
} from "./documentAgentState";

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;

export interface RhwpStudioSurfaceHandle {
  saveAndReturn(): Promise<void>;
  focusField(fieldId: string): Promise<boolean>;
  prepareFieldWritingSession(fieldId: string): Promise<PreparedFieldWritingSession>;
  requestFieldSuggestion(fieldId: string, sourceText?: string): Promise<FieldAgentRunDto>;
  applyFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
  undoFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
  dismissFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
}

export interface PreparedFieldWritingSession {
  fieldId: string;
  baseRevisionId: string;
  target: StudioFieldTargetV1;
}

type StudioState =
  | { status: "loading"; message: string; allowEditorInteraction?: boolean }
  | { status: "ready"; pageCount: number; skipped: RhwpWorkingDocument["skipped"] }
  | { status: "error"; message: string };

type StudioSaveIntent = "auto" | "stay" | "return";

export const RhwpStudioSurface = forwardRef<RhwpStudioSurfaceHandle, {
  transport: RhwpWorkingDocumentTransport;
  answers: DraftFieldAnswers;
  quickFields: readonly ConnectedDocumentField[];
  connectedFields: readonly RhwpFieldDescriptor[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels: ReadonlySet<string>;
  workingDocument: RhwpWorkingDocument | null;
  headMaterializedAnswers: Record<string, string>;
  activeTask: DocumentAuthoringTask | null;
  documentAgentAvailable?: boolean;
  fieldEditorAgentAvailable?: boolean;
  presentation?: "standalone" | "field_aware";
  onFieldBindingsResolved?: (resolutions: readonly StudioFieldBindingResolution[]) => void;
  onFieldSelectionChanged?: (target: StudioFieldTargetV1 | null) => void;
  onSaved: (
    document: RhwpWorkingDocument,
    taskFieldId: string | null,
    returnToQuick: boolean,
  ) => void;
}>(({
  transport,
  answers,
  quickFields,
  connectedFields,
  manualAnchors,
  duplicateLabels,
  workingDocument,
  headMaterializedAnswers,
  activeTask,
  documentAgentAvailable = false,
  fieldEditorAgentAvailable = false,
  presentation = "standalone",
  onFieldBindingsResolved,
  onFieldSelectionChanged,
  onSaved,
}, ref) => {
  const localPreview = transport.mode === "local_preview";
  const sourceKey = sourceKeyForTransport(transport);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StudioState>({ status: "loading", message: "작업 문서를 준비하고 있어요." });
  const [saveState, dispatchSave] = useReducer(reduceStudioSaveState, initialStudioSaveState);
  const [agentState, dispatchAgent] = useReducer(reduceDocumentAgentUiState, initialDocumentAgentUiState);
  const [agentCapabilityReady, setAgentCapabilityReady] = useState(false);
  const [agentHardLock, setAgentHardLock] = useState<string | null>(null);
  const [fieldAgentBusy, setFieldAgentBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const saveProtocolRef = useRef<RhwpStudioSaveProtocol | null>(null);
  const agentTransactionRef = useRef<StudioCommandDocumentAgentTransaction | null>(null);
  const fieldAgentTransactionRef = useRef<StudioFieldAgentTransaction | null>(null);
  const fieldNavigationProtocolRef = useRef<StudioFieldNavigationProtocol | null>(null);
  const fieldTargetsRef = useRef<Map<string, StudioFieldTargetV1>>(new Map());
  const agentCandidatesRef = useRef<DocumentEditCandidate[]>([]);
  const agentReservedAnchorsRef = useRef<DocumentAgentReservedAnchor[]>([]);
  const latestAppliedSuggestionIdRef = useRef<string | null>(null);
  const preparedRef = useRef<RhwpWorkingDocument | null>(null);
  const onSavedRef = useRef(onSaved);
  const onFieldBindingsResolvedRef = useRef(onFieldBindingsResolved);
  const onFieldSelectionChangedRef = useRef(onFieldSelectionChanged);
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
    onFieldBindingsResolvedRef.current = onFieldBindingsResolved;
  }, [onFieldBindingsResolved]);

  useEffect(() => {
    onFieldSelectionChangedRef.current = onFieldSelectionChanged;
  }, [onFieldSelectionChanged]);

  useEffect(() => {
    activeTaskFieldIdRef.current = activeTask?.fieldId ?? null;
  }, [activeTask?.fieldId]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let disposed = false;
    let unsubscribeDocumentChanged: (() => void) | null = null;
    let unsubscribeFieldSelectionChanged: (() => void) | null = null;
    const initialize = async () => {
      const initializationInput = initializationInputRef.current;
      setState({
        status: "loading",
        message: presentation === "field_aware"
          ? "현재 문서와 입력할 위치를 확인하고 있어요."
          : "확정한 빠른 작성 값을 원본 문서에 반영하고 있어요.",
      });
      const prepared = await prepareRhwpWorkingDocument({
        transport,
        answers: initializationInput.answers,
        connectedFields: initializationInput.quickFields,
        manualAnchors: initializationInput.manualAnchors,
        duplicateLabels: initializationInput.duplicateLabels,
        base: sessionDocumentRef.current,
        baseMaterializedAnswers: initializationInput.headMaterializedAnswers,
      });
      if (disposed || requestSeq.current !== seq) return;
      preparedRef.current = prepared;
      try {
        const bindingRhwp = await loadRhwp();
        const bindingDocument = new bindingRhwp.HwpDocument(prepared.bytes);
        try {
          const resolutions = resolveStudioFieldBindings(bindingDocument, connectedFields);
          fieldTargetsRef.current = new Map(resolutions.flatMap((resolution) => {
            if (resolution.status !== "unique") return [];
            return [[resolution.fieldId, resolution.target]];
          }));
          onFieldBindingsResolvedRef.current?.(resolutions);
        } finally {
          bindingDocument.free();
        }
      } catch (error) {
        console.warn("rhwp Studio field binding 해석 실패", error);
        fieldTargetsRef.current = new Map();
        onFieldBindingsResolvedRef.current?.([]);
      }
      setState({ status: "loading", message: "문서 편집 화면을 불러오고 있어요." });
      const { createEditor } = await import("@rhwp/editor");
      const container = containerRef.current;
      if (!container) throw new Error("문서 편집 화면을 준비하지 못했습니다.");
      const timeoutMs = studioInitializationTimeoutMs(prepared.bytes.byteLength);
      let initialized: { editor: RhwpEditorInstance; result: { pageCount: number } } | null = null;
      let lastInitializationError: unknown = null;

      for (let editorAttempt = 0; editorAttempt < STUDIO_INITIALIZATION_ATTEMPTS; editorAttempt += 1) {
        let attemptCancelled = false;
        const attemptState: { editor: RhwpEditorInstance | null } = { editor: null };
        if (editorAttempt > 0) {
          setState({
            status: "loading",
            message: "문서 편집 화면을 여는 데 시간이 걸려 다시 준비하고 있어요.",
          });
        }
        container.replaceChildren();
        const initializeEditor = (async () => {
          const candidate = await createEditor(container, {
            studioUrl: studioUrlForInitializationAttempt(
              RHWP_STUDIO_URL,
              editorAttempt,
              studioSessionIdRef.current!,
            ),
            requestTimeoutMs: 180_000,
          });
          if (attemptCancelled || disposed || requestSeq.current !== seq) {
            candidate.destroy();
            throw new Error("문서 편집기 초기화가 취소되었습니다.");
          }
          attemptState.editor = candidate;
          setState({
            status: "loading",
            message: "문서 내용을 편집 화면에 펼치고 있어요.",
            allowEditorInteraction: false,
          });
          const loadResult = await loadEditorFileWithoutDialogs(
            candidate,
            prepared.bytes.slice(),
            prepared.filename,
          );
          return { editor: candidate, result: loadResult };
        })();

        try {
          initialized = await withStudioInitializationTimeout(initializeEditor, timeoutMs);
          break;
        } catch (error) {
          attemptCancelled = true;
          lastInitializationError = error;
          attemptState.editor?.destroy();
          attemptState.editor = null;
          container.replaceChildren();
          if (!(error instanceof StudioInitializationTimeoutError)
            || editorAttempt + 1 >= STUDIO_INITIALIZATION_ATTEMPTS) {
            throw error;
          }
        }
      }

      if (!initialized) {
        throw lastInitializationError ?? new Error("문서 편집기를 준비하지 못했습니다.");
      }
      const { editor, result } = initialized;
      if (disposed || requestSeq.current !== seq) {
        editor.destroy();
        return;
      }
      editorRef.current = editor;
      fieldNavigationProtocolRef.current = resolveStudioFieldNavigationProtocol(editor);
      const fieldSelectionProtocol = resolveStudioFieldSelectionProtocol(editor);
      if (presentation === "field_aware" && fieldSelectionProtocol) {
        const publishFieldSelection = (selection: Awaited<ReturnType<
          typeof fieldSelectionProtocol.getFieldSelectionContext
        >>) => {
          if (disposed || requestSeq.current !== seq) return;
          onFieldSelectionChangedRef.current?.(
            selection.editable ? selection.target : null,
          );
        };
        unsubscribeFieldSelectionChanged = fieldSelectionProtocol.onFieldSelectionChanged(
          publishFieldSelection,
        );
        publishFieldSelection(await fieldSelectionProtocol.getFieldSelectionContext());
      }
      const saveProtocol = resolveRhwpStudioSaveProtocol(editor);
      saveProtocolRef.current = saveProtocol;
      const agentProtocol = resolveStudioDocumentAgentProtocol(editor);
      if (documentAgentAvailable && transport.mode === "persistent" && agentProtocol) {
        const rhwp = await loadRhwp();
        agentTransactionRef.current = createStudioCommandDocumentAgentTransaction({
          rhwp,
          protocol: agentProtocol,
          exportCurrentBytes: (format) => exportVerifiedEditorDocument(editor, format),
        });
        setAgentCapabilityReady(true);
      } else {
        agentTransactionRef.current = null;
        setAgentCapabilityReady(false);
      }
      const fieldAgentProtocol = resolveStudioFieldAgentProtocol(editor);
      if (
        fieldEditorAgentAvailable
        && presentation === "field_aware"
        && transport.mode === "persistent"
        && fieldAgentProtocol
      ) {
        const rhwp = await loadRhwp();
        fieldAgentTransactionRef.current = createStudioFieldAgentTransaction({
          rhwp,
          protocol: fieldAgentProtocol,
          exportCurrentBytes: (format) => exportVerifiedEditorDocument(editor, format),
        });
      } else {
        fieldAgentTransactionRef.current = null;
      }
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
      unsubscribeFieldSelectionChanged?.();
      editorRef.current?.destroy();
      editorRef.current = null;
      saveProtocolRef.current = null;
      agentTransactionRef.current = null;
      fieldAgentTransactionRef.current = null;
      fieldNavigationProtocolRef.current = null;
      fieldTargetsRef.current = new Map();
      agentCandidatesRef.current = [];
      agentReservedAnchorsRef.current = [];
      latestAppliedSuggestionIdRef.current = null;
      setAgentCapabilityReady(false);
      preparedRef.current = null;
    };
    // Studio는 현재 draft에서 한 번만 생성한다. 빠른 작성 값이 바뀌었다고 iframe을 파괴해
    // 재로드하면 글꼴 권한 확인이 매번 반복된다. 최신 빠른 작성 값은 최종 저장에서 delta로 합친다.
  }, [attempt, documentAgentAvailable, fieldEditorAgentAvailable, presentation, sourceKey]);

  const save = useCallback(async (intent: StudioSaveIntent): Promise<RhwpWorkingDocument | null> => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (
      !editor
      || !prepared
      || saveInFlightRef.current
      || state.status === "loading"
      || state.status === "error"
    ) return null;
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
      const commit = await commitStudioSnapshot({
        transport,
        persist: async (draftId) => {
          dispatchSave({ type: "save-phase", phase: "uploading" });
          return persistStudioSnapshot({
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
            materializedAnswers: tabSnapshot!.materializedAnswers,
            verification: {
              client: "rhwp-core-reopen",
              verified: true,
              supportsChangeEvents,
            },
          });
        },
      });
      if (commit.mode === "local_preview") {
        const savedAt = new Date().toISOString();
        await notifyEditorSaved(editor).catch((error) => {
          console.warn("rhwp Studio 탭 저장 완료 통지 실패", error);
        });
        if (!supportsChangeEvents) legacySaveSeqRef.current = savedSeq;
        onSavedRef.current(tabSnapshot, activeTaskFieldIdRef.current, intent === "return");
        dispatchSave({
          type: "tab-snapshot",
          savedAt,
          message: "가상 기업 편집본을 현재 브라우저 탭에만 반영했습니다.",
        });
        if (intent === "stay") {
          toast.success("편집본을 이 브라우저 탭에 반영했습니다.");
        } else if (intent === "return") {
          toast.success("편집본을 이 탭에 반영하고 빠른 작성으로 돌아갑니다.");
        }
        const currentSeq = latestChangeSeqRef.current;
        if (supportsChangeEvents && currentSeq !== null && currentSeq > savedSeq) {
          scheduleAutosaveRef.current(currentSeq);
        }
        return tabSnapshot;
      }
      const persisted = commit.value;
      const serverSnapshot: RhwpWorkingDocument = {
        ...tabSnapshot,
        revisionId: persisted.revisionId,
        serverSavedAt: persisted.savedAt,
      };
      preparedRef.current = serverSnapshot;
      sessionDocumentRef.current = serverSnapshot;
      await notifyEditorSaved(editor).catch((error) => {
        console.warn("rhwp Studio 서버 저장 완료 통지 실패", error);
      });
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
      return serverSnapshot;
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
      return tabSnapshot;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [localPreview, sourceKey, state.status, transport]);

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
      if (!saveProtocolRef.current?.supportsChangeEvents || saveInFlightRef.current) return;
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
  }, [save, saveState.kind, sourceKey]);

  const saveAndReturn = useCallback(async () => {
    await save("return");
  }, [save]);

  const focusField = useCallback(async (fieldId: string): Promise<boolean> => {
    const protocol = fieldNavigationProtocolRef.current;
    const target = fieldTargetsRef.current.get(fieldId);
    if (!protocol || !target) return false;
    try {
      const result = await protocol.focusFieldTarget(target);
      if (!result.focused) toast.error("문서에서 이 필드의 입력 셀로 이동하지 못했습니다.");
      return result.focused;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "필드 입력 셀로 이동하지 못했습니다.");
      return false;
    }
  }, []);

  const downloadCurrentCopy = useCallback(async () => {
    const editor = editorRef.current;
    const document = preparedRef.current;
    if (!editor || !document || state.status !== "ready" || downloadBusy) return;
    setDownloadBusy(true);
    try {
      const bytes = await exportVerifiedEditorDocument(editor, document.format);
      const base = document.filename.replace(/\.(hwp|hwpx)$/i, "");
      const suffix = localPreview ? "가상기업-작성본" : "작업본";
      downloadBytes(bytes, `${base}-${suffix}.${document.format}`);
      toast.success("현재 편집본을 검증해 다운로드했습니다.");
    } catch (error) {
      toast.error(errorMessage(error, "현재 편집본을 다운로드하지 못했습니다."));
    } finally {
      setDownloadBusy(false);
    }
  }, [downloadBusy, localPreview, state.status]);

  const clearAutosaveTimers = useCallback(() => {
    if (autosaveIdleTimerRef.current) clearTimeout(autosaveIdleTimerRef.current);
    if (autosaveMaxTimerRef.current) clearTimeout(autosaveMaxTimerRef.current);
    autosaveIdleTimerRef.current = null;
    autosaveMaxTimerRef.current = null;
  }, []);

  const beginAgentMutation = useCallback(() => {
    if (saveInFlightRef.current || agentHardLock) {
      throw new Error(agentHardLock ?? "다른 문서 저장 작업이 끝난 뒤 다시 시도해 주세요.");
    }
    saveInFlightRef.current = true;
    clearAutosaveTimers();
  }, [agentHardLock, clearAutosaveTimers]);

  const finishAgentMutation = useCallback((keepLocked = false) => {
    if (!keepLocked) saveInFlightRef.current = false;
  }, []);

  const acceptPersistedAgentSnapshot = useCallback(async (input: {
    bytes: Uint8Array;
    revisionId: string;
    savedAt: string;
    changeSeq: number;
    materializedAnswers?: Record<string, string>;
  }) => {
    const prepared = preparedRef.current;
    const editor = editorRef.current;
    if (!prepared || !editor) throw new Error("현재 Studio 작업본을 찾지 못했습니다.");
    const snapshot: RhwpWorkingDocument = {
      ...prepared,
      bytes: input.bytes,
      revisionId: input.revisionId,
      serverSavedAt: input.savedAt,
      ...(input.materializedAnswers ? { materializedAnswers: input.materializedAnswers } : {}),
    };
    preparedRef.current = snapshot;
    sessionDocumentRef.current = snapshot;
    await notifyEditorSaved(editor).catch((error) => {
      console.warn("rhwp Studio AI revision 저장 완료 통지 실패", error);
    });
    try {
      onSavedRef.current(snapshot, activeTaskFieldIdRef.current, false);
    } catch (error) {
      console.error("rhwp Studio AI revision parent state 반영 실패", error);
    }
    dispatchSave({
      type: "save-succeeded",
      revisionId: input.revisionId,
      savedAt: input.savedAt,
      savedSeq: input.changeSeq,
      currentSeq: latestChangeSeqRef.current,
      supportsChangeEvents: saveProtocolRef.current?.supportsChangeEvents ?? false,
    });
  }, []);

  const readCurrentAgentDocument = useCallback(async () => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (!editor || !prepared) throw new Error("현재 Studio 작업본을 찾지 못했습니다.");
    const bytes = await exportVerifiedEditorDocument(editor, prepared.format);
    const documentSha256 = await sha256Hex(bytes);
    const rhwp = await loadRhwp();
    const document = new rhwp.HwpDocument(bytes);
    try {
      const resolutions = resolveRhwpFieldAnchorsExact(document, connectedFields);
      const reservedAnchors = reservedAnchorsFromExactResolutions(resolutions);
      return { bytes, documentSha256, reservedAnchors, resolutions, pageCount: document.pageCount() };
    } finally {
      document.free();
    }
  }, [connectedFields]);

  const readCurrentFieldDocument = useCallback(async () => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (!editor || !prepared) throw new Error("현재 Studio 작업본을 찾지 못했습니다.");
    const bytes = await exportVerifiedEditorDocument(editor, prepared.format);
    const documentSha256 = await sha256Hex(bytes);
    const rhwp = await loadRhwp();
    const document = new rhwp.HwpDocument(bytes);
    try {
      return {
        bytes,
        documentSha256,
        documentSemanticSha256: await studioFieldDocumentSemanticSha256(document),
        resolutions: resolveStudioFieldBindings(document, connectedFields),
        pageCount: document.pageCount(),
      };
    } finally {
      document.free();
    }
  }, [connectedFields]);

  const refreshRun = useCallback(async (runId: string): Promise<DocumentAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    const runs = await fetchDocumentAgentRuns(transport.draftId);
    const run = runs.find((entry) => entry.id === runId);
    if (!run) throw new Error("갱신된 문서 작성 제안을 찾지 못했습니다.");
    return run;
  }, [transport]);

  const openDocumentAgent = useCallback(async () => {
    if (!agentCapabilityReady || state.status !== "ready" || transport.mode !== "persistent") return;
    dispatchAgent({ type: "open", pageCount: state.pageCount });
    try {
      const [recent] = await fetchDocumentAgentRuns(transport.draftId);
      if (recent) dispatchAgent({ type: "history_loaded", run: recent });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "최근 문서 제안을 불러오지 못했습니다.");
    }
  }, [agentCapabilityReady, state, transport]);

  const scanDocumentAgentPage = useCallback(async () => {
    dispatchAgent({ type: "scan_started" });
    try {
      const current = await readCurrentAgentDocument();
      const rhwp = await loadRhwp();
      const document = new rhwp.HwpDocument(current.bytes);
      try {
        const candidates = await extractDocumentEditCandidates({
          document,
          sourceKey,
          documentSha256: current.documentSha256,
          selectedPage: agentState.selectedPage,
          reservedAnchors: current.reservedAnchors,
        });
        agentCandidatesRef.current = candidates;
        agentReservedAnchorsRef.current = current.reservedAnchors;
        dispatchAgent({ type: "scan_succeeded", candidates });
        if (candidates.length === 0) toast.info("이 쪽에서 안전하게 바꿀 수 있는 독립 본문을 찾지 못했습니다.");
      } finally {
        document.free();
      }
    } catch (error) {
      dispatchAgent({ type: "failed", message: errorMessage(error, "작성 위치를 찾지 못했습니다.") });
    }
  }, [agentState.selectedPage, readCurrentAgentDocument, sourceKey]);

  const requestAgentSuggestions = useCallback(async () => {
    if (transport.mode !== "persistent") return;
    const candidate = agentCandidatesRef.current.find(
      (entry) => entry.candidateId === agentState.selectedCandidateId,
    );
    const prepared = preparedRef.current;
    const editor = editorRef.current;
    if (!candidate || !prepared || !editor) return;
    const checkpointRequestId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();
    dispatchAgent({ type: "request_started", checkpointRequestId, clientRequestId });
    try {
      beginAgentMutation();
      const current = await readCurrentAgentDocument();
      if (current.documentSha256 !== candidate.documentSha256) {
        throw new Error("문서가 후보 탐색 뒤 변경되었습니다. 작성 위치를 다시 찾아 주세요.");
      }
      const changeSeq = latestChangeSeqRef.current ?? legacySaveSeqRef.current + 1;
      const checkpoint = await persistStudioSnapshot({
        draftId: transport.draftId,
        bytes: current.bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount: current.pageCount,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: prepared.revisionId,
        documentEpoch: documentEpochRef.current,
        changeSeq,
        origin: "studio_agent_checkpoint",
        checkpointRequestId,
        materializedAnswers: prepared.materializedAnswers,
        verification: {
          client: "rhwp-core-reopen",
          verified: true,
          purpose: "document_agent_checkpoint",
          documentSha256: current.documentSha256,
        },
      });
      await acceptPersistedAgentSnapshot({
        bytes: current.bytes,
        revisionId: checkpoint.revisionId,
        savedAt: checkpoint.savedAt,
        changeSeq,
      });
      dispatchAgent({ type: "checkpoint_saved" });
      const result = await requestDocumentAgentSuggestions({
        draftId: transport.draftId,
        clientRequestId,
        checkpointRequestId,
        baseRevisionId: checkpoint.revisionId,
        selectedPage: agentState.selectedPage,
        candidateId: candidate.candidateId,
        anchor: candidate.anchor,
      });
      dispatchAgent({ type: "run_received", run: result.run });
    } catch (error) {
      dispatchAgent({ type: "failed", message: errorMessage(error, "문서 작성 제안을 만들지 못했습니다.") });
    } finally {
      finishAgentMutation();
    }
  }, [acceptPersistedAgentSnapshot, agentState.selectedCandidateId, agentState.selectedPage, beginAgentMutation, finishAgentMutation, readCurrentAgentDocument, transport]);

  const dismissAgentSuggestion = useCallback(async (suggestionId: string) => {
    if (transport.mode !== "persistent" || !agentState.run) return;
    const suggestion = agentState.run.suggestions.find((entry) => entry.id === suggestionId);
    if (!suggestion) return;
    try {
      await transitionDocumentAgentSuggestion({
        draftId: transport.draftId,
        suggestionId,
        action: "dismiss",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
      });
      dispatchAgent({ type: "run_received", run: await refreshRun(agentState.run.id) });
    } catch (error) {
      dispatchAgent({ type: "failed", message: errorMessage(error, "제안을 건너뛰지 못했습니다.") });
    }
  }, [agentState.run, refreshRun, transport]);

  const applyAgentSuggestion = useCallback(async (suggestionId: string) => {
    if (transport.mode !== "persistent" || !agentState.run) return;
    const run = agentState.run;
    const suggestion = run.suggestions.find((entry) => entry.id === suggestionId);
    const transaction = agentTransactionRef.current;
    const prepared = preparedRef.current;
    if (!suggestion || !transaction || !prepared) return;
    const operationClientId = crypto.randomUUID();
    let started: DocumentAgentSuggestionDto | null = null;
    let applied: Awaited<ReturnType<StudioCommandDocumentAgentTransaction["apply"]>> | null = null;
    let keepLocked = false;
    dispatchAgent({ type: "operation_started", operation: "apply" });
    try {
      beginAgentMutation();
      const approved = await transitionDocumentAgentSuggestion({
        draftId: transport.draftId,
        suggestionId,
        action: "approve",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
      });
      if (approved.status !== "approved") {
        dispatchAgent({ type: "operation_finished", run: await refreshRun(run.id) });
        toast.error("제안 근거나 문서 기준이 바뀌어 이 제안을 반영하지 않았습니다.");
        return;
      }
      started = await transitionDocumentAgentSuggestion({
        draftId: transport.draftId,
        suggestionId,
        action: "start_apply",
        expectedStatusVersion: approved.statusVersion,
        expectedOperationVersion: approved.operationVersion,
        operationClientId,
      });
      const current = await readCurrentAgentDocument();
      agentReservedAnchorsRef.current = current.reservedAnchors;
      applied = await transaction.apply({
        bytes: current.bytes,
        format: prepared.format,
        reservedAnchors: current.reservedAnchors,
        command: {
          schemaVersion: "document-agent-v1",
          candidate: run.candidate,
          replacement: suggestion.afterText,
        },
      });
      const persisted = await persistStudioSnapshot({
        draftId: transport.draftId,
        bytes: applied.bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount: current.pageCount,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: run.baseRevisionId,
        documentEpoch: applied.studioReceipt.documentEpoch,
        changeSeq: applied.studioReceipt.afterChangeSeq,
        origin: "studio_agent_apply",
        agentSuggestionId: suggestion.id,
        agentOperation: "apply",
        operationVersion: started.operationVersion,
        materializedAnswers: prepared.materializedAnswers,
        verification: agentVerification(applied, suggestion.id),
      });
      await acceptPersistedAgentSnapshot({
        bytes: applied.bytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: applied.studioReceipt.afterChangeSeq,
      });
      latestAppliedSuggestionIdRef.current = suggestion.id;
      const optimistic = replaceSuggestion(run, {
        ...started,
        status: "applied",
        statusVersion: started.statusVersion + 1,
        operationState: "idle",
        operationVersion: started.operationVersion + 1,
        operationStartedAt: null,
        operationClientId: null,
        failureCode: null,
        appliedDocumentSha256: applied.afterDocumentSha256,
        appliedRevisionId: persisted.revisionId,
        appliedAt: persisted.savedAt,
        updatedAt: persisted.savedAt,
      });
      dispatchAgent({ type: "operation_finished", run: optimistic });
      toast.success("승인한 문안만 문서에 반영하고 새 revision으로 저장했습니다.");
      void refreshRun(run.id).then((fresh) => dispatchAgent({ type: "run_received", run: fresh })).catch(() => undefined);
    } catch (error) {
      const mutationCommitted = applied !== null || error instanceof StudioDocumentAgentVerificationError;
      if (mutationCommitted) {
        if (!applied) {
          keepLocked = true;
          const message = "Studio 변경은 발생했지만 검증하지 못했습니다. 이 탭의 편집을 잠그고 새로고침을 요구합니다.";
          setAgentHardLock(message);
          dispatchAgent({ type: "failed", message });
        } else {
          const failureCode = agentPersistenceFailureCode(error);
          let failed: DocumentAgentSuggestionDto | null = null;
          try {
            failed = await transitionDocumentAgentSuggestion({
              draftId: transport.draftId,
              suggestionId,
              action: "apply_save_failed",
              expectedStatusVersion: started!.statusVersion,
              expectedOperationVersion: started!.operationVersion,
              operationClientId,
              documentSha256: applied.afterDocumentSha256,
              failureCode,
            });
          } catch {
            // 서버 상태가 바뀌었어도 로컬 문서는 먼저 exact rollback한다.
          }
          try {
            const rolledBack = await transaction.undo({
              bytes: applied.bytes,
              format: prepared.format,
              reservedAnchors: agentReservedAnchorsRef.current,
              command: { schemaVersion: "document-agent-v1", candidate: run.candidate, afterText: suggestion.afterText },
            });
            if (editorRef.current) await notifyEditorSaved(editorRef.current);
            if (failed) {
              await transitionDocumentAgentSuggestion({
                draftId: transport.draftId,
                suggestionId,
                action: "abandon_apply",
                expectedStatusVersion: failed.statusVersion,
                expectedOperationVersion: failed.operationVersion,
                operationClientId,
                documentSha256: rolledBack.afterDocumentSha256,
                failureCode: "apply_rolled_back",
              });
            }
            dispatchAgent({ type: "failed", message: `${errorMessage(error, "AI 변경을 저장하지 못했습니다.")} 문서 변경은 원상 복구했습니다.` });
          } catch (rollbackError) {
            keepLocked = true;
            const message = `AI 변경 저장과 원상 복구가 모두 실패해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`;
            setAgentHardLock(message);
            dispatchAgent({ type: "failed", message });
          }
        }
      } else {
        if (started) {
          await transitionDocumentAgentSuggestion({
            draftId: transport.draftId,
            suggestionId,
            action: "abandon_apply",
            expectedStatusVersion: started.statusVersion,
            expectedOperationVersion: started.operationVersion,
            operationClientId,
            failureCode: "core_validation_failed",
          }).catch(() => undefined);
        }
        dispatchAgent({ type: "failed", message: errorMessage(error, "제안을 문서에 반영하지 못했습니다.") });
      }
    } finally {
      finishAgentMutation(keepLocked);
    }
  }, [acceptPersistedAgentSnapshot, agentState.run, beginAgentMutation, finishAgentMutation, readCurrentAgentDocument, refreshRun, transport]);

  const undoAgentSuggestion = useCallback(async (suggestionId: string) => {
    if (transport.mode !== "persistent" || !agentState.run || latestAppliedSuggestionIdRef.current !== suggestionId) return;
    const run = agentState.run;
    const suggestion = run.suggestions.find((entry) => entry.id === suggestionId);
    const transaction = agentTransactionRef.current;
    const prepared = preparedRef.current;
    if (!suggestion || !transaction || !prepared) return;
    const operationClientId = crypto.randomUUID();
    let started: DocumentAgentSuggestionDto | null = null;
    let undone: Awaited<ReturnType<StudioCommandDocumentAgentTransaction["undo"]>> | null = null;
    let keepLocked = false;
    dispatchAgent({ type: "operation_started", operation: "undo" });
    try {
      beginAgentMutation();
      started = await transitionDocumentAgentSuggestion({
        draftId: transport.draftId,
        suggestionId,
        action: "authorize_undo",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
        operationClientId,
      });
      const current = await readCurrentAgentDocument();
      agentReservedAnchorsRef.current = current.reservedAnchors;
      undone = await transaction.undo({
        bytes: current.bytes,
        format: prepared.format,
        reservedAnchors: current.reservedAnchors,
        command: { schemaVersion: "document-agent-v1", candidate: run.candidate, afterText: suggestion.afterText },
      });
      const persisted = await persistStudioSnapshot({
        draftId: transport.draftId,
        bytes: undone.bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount: current.pageCount,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: suggestion.appliedRevisionId,
        documentEpoch: undone.studioReceipt.documentEpoch,
        changeSeq: undone.studioReceipt.afterChangeSeq,
        origin: "studio_agent_undo",
        agentSuggestionId: suggestion.id,
        agentOperation: "undo",
        operationVersion: started.operationVersion,
        materializedAnswers: prepared.materializedAnswers,
        verification: agentVerification(undone, suggestion.id),
      });
      await acceptPersistedAgentSnapshot({
        bytes: undone.bytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: undone.studioReceipt.afterChangeSeq,
      });
      latestAppliedSuggestionIdRef.current = null;
      const optimistic = replaceSuggestion(run, {
        ...started,
        status: "undone",
        statusVersion: started.statusVersion + 1,
        operationState: "idle",
        operationVersion: started.operationVersion + 1,
        operationStartedAt: null,
        operationClientId: null,
        failureCode: null,
        undoneDocumentSha256: undone.afterDocumentSha256,
        undoneRevisionId: persisted.revisionId,
        undoneAt: persisted.savedAt,
        updatedAt: persisted.savedAt,
      });
      dispatchAgent({ type: "operation_finished", run: optimistic });
      toast.success("최근 AI 변경을 새 revision으로 되돌렸습니다.");
      void refreshRun(run.id).then((fresh) => dispatchAgent({ type: "run_received", run: fresh })).catch(() => undefined);
    } catch (error) {
      const mutationCommitted = undone !== null || error instanceof StudioDocumentAgentVerificationError;
      if (mutationCommitted) {
        if (!undone) {
          keepLocked = true;
          const message = "Studio 되돌리기는 발생했지만 검증하지 못했습니다. 이 탭의 편집을 잠갔습니다.";
          setAgentHardLock(message);
          dispatchAgent({ type: "failed", message });
        } else {
          const failureCode = agentPersistenceFailureCode(error, true);
          let failed: DocumentAgentSuggestionDto | null = null;
          try {
            failed = await transitionDocumentAgentSuggestion({
              draftId: transport.draftId,
              suggestionId,
              action: "undo_save_failed",
              expectedStatusVersion: started!.statusVersion,
              expectedOperationVersion: started!.operationVersion,
              operationClientId,
              documentSha256: undone.afterDocumentSha256,
              failureCode,
            });
          } catch {
            // 서버 상태와 무관하게 로컬 applied 상태부터 복구한다.
          }
          try {
            const restored = await transaction.apply({
              bytes: undone.bytes,
              format: prepared.format,
              reservedAnchors: agentReservedAnchorsRef.current,
              command: { schemaVersion: "document-agent-v1", candidate: run.candidate, replacement: suggestion.afterText },
            });
            if (editorRef.current) await notifyEditorSaved(editorRef.current);
            if (failed) {
              await transitionDocumentAgentSuggestion({
                draftId: transport.draftId,
                suggestionId,
                action: "abandon_undo",
                expectedStatusVersion: failed.statusVersion,
                expectedOperationVersion: failed.operationVersion,
                operationClientId,
                documentSha256: restored.afterDocumentSha256,
                failureCode: "undo_rolled_back",
              });
            }
            dispatchAgent({ type: "failed", message: `${errorMessage(error, "되돌린 문서를 저장하지 못했습니다.")} 문서는 AI 반영 상태로 복구했습니다.` });
          } catch (rollbackError) {
            keepLocked = true;
            const message = `Undo 저장과 로컬 복구가 모두 실패해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`;
            setAgentHardLock(message);
            dispatchAgent({ type: "failed", message });
          }
        }
      } else {
        if (started) {
          await transitionDocumentAgentSuggestion({
            draftId: transport.draftId,
            suggestionId,
            action: "abandon_undo",
            expectedStatusVersion: started.statusVersion,
            expectedOperationVersion: started.operationVersion,
            operationClientId,
            failureCode: "undo_conflict",
          }).catch(() => undefined);
        }
        dispatchAgent({ type: "failed", message: errorMessage(error, "최근 AI 변경을 되돌리지 못했습니다.") });
      }
    } finally {
      finishAgentMutation(keepLocked);
    }
  }, [acceptPersistedAgentSnapshot, agentState.run, beginAgentMutation, finishAgentMutation, readCurrentAgentDocument, refreshRun, transport]);

  const refreshFieldRun = useCallback(async (runId: string): Promise<FieldAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    const runs = await fetchFieldAgentRuns(transport.draftId);
    const run = runs.find((entry) => entry.id === runId);
    if (!run) throw new Error("갱신된 AI 필드 제안을 찾지 못했습니다.");
    return run;
  }, [transport]);

  const checkpointFieldWritingSession = useCallback(async (
    fieldId: string,
  ): Promise<PreparedFieldWritingSession> => {
    if (transport.mode !== "persistent" || !fieldAgentTransactionRef.current) {
      throw new Error("현재 Studio에서는 AI 필드 명령을 사용할 수 없습니다.");
    }
    const prepared = preparedRef.current;
    if (!prepared) throw new Error("현재 Studio 작업본을 찾지 못했습니다.");
    const current = await readCurrentFieldDocument();
    const resolution = current.resolutions.find((entry) => entry.fieldId === fieldId);
    if (!resolution || resolution.status !== "unique") {
      throw new Error("현재 revision에서 이 필드의 입력 셀을 하나로 확정하지 못했습니다.");
    }
    const target = resolution.target;
    fieldTargetsRef.current.set(fieldId, target);
    onFieldBindingsResolvedRef.current?.(current.resolutions);
    const changeSeq = latestChangeSeqRef.current ?? legacySaveSeqRef.current + 1;
    const checkpoint = await persistStudioSnapshot({
      draftId: transport.draftId,
      bytes: current.bytes,
      filename: prepared.filename,
      format: prepared.format,
      pageCount: current.pageCount,
      sessionId: studioSessionIdRef.current!,
      baseRevisionId: prepared.revisionId,
      documentEpoch: documentEpochRef.current,
      changeSeq,
      origin: "studio_agent_checkpoint",
      checkpointRequestId: crypto.randomUUID(),
      materializedAnswers: prepared.materializedAnswers,
      verification: {
        client: "rhwp-core-reopen",
        verified: true,
        purpose: "field_agent_checkpoint",
        documentSha256: current.documentSha256,
        fieldId,
      },
    });
    await acceptPersistedAgentSnapshot({
      bytes: current.bytes,
      revisionId: checkpoint.revisionId,
      savedAt: checkpoint.savedAt,
      changeSeq,
    });
    return { fieldId, baseRevisionId: checkpoint.revisionId, target };
  }, [acceptPersistedAgentSnapshot, readCurrentFieldDocument, transport]);

  const prepareFieldWritingSession = useCallback(async (
    fieldId: string,
  ): Promise<PreparedFieldWritingSession> => {
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      return await checkpointFieldWritingSession(fieldId);
    } finally {
      finishAgentMutation();
      setFieldAgentBusy(false);
    }
  }, [beginAgentMutation, checkpointFieldWritingSession, finishAgentMutation]);

  const requestFieldSuggestion = useCallback(async (
    fieldId: string,
    sourceText?: string,
  ): Promise<FieldAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      const session = await checkpointFieldWritingSession(fieldId);
      return await requestFieldAgentRun({
        draftId: transport.draftId,
        fieldId,
        clientRequestId: crypto.randomUUID(),
        baseRevisionId: session.baseRevisionId,
        target: session.target,
        ...(sourceText?.trim() ? { sourceText: sourceText.trim() } : {}),
      });
    } finally {
      finishAgentMutation();
      setFieldAgentBusy(false);
    }
  }, [beginAgentMutation, checkpointFieldWritingSession, finishAgentMutation, transport]);

  const applyFieldSuggestion = useCallback(async (
    run: FieldAgentRunDto,
    suggestion: FieldAgentSuggestionDto,
  ): Promise<FieldAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    const transaction = fieldAgentTransactionRef.current;
    const prepared = preparedRef.current;
    if (!transaction || !prepared) throw new Error("현재 Studio에서 필드 명령을 실행할 수 없습니다.");
    const operationClientId = crypto.randomUUID();
    let started: FieldAgentSuggestionDto | null = null;
    let applied: Awaited<ReturnType<StudioFieldAgentTransaction["apply"]>> | null = null;
    let keepLocked = false;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      started = await transitionFieldAgentRunSuggestion({
        draftId: transport.draftId,
        suggestionId: suggestion.id,
        action: "start_apply",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
        operationClientId,
      });
      const current = await readCurrentFieldDocument();
      if (!matchesStudioFieldDocumentPreimage({
        currentDocumentSha256: current.documentSha256,
        currentSemanticSha256: current.documentSemanticSha256,
        expectedDocumentSha256: run.documentSha256,
        expectedSemanticSha256: run.documentSemanticSha256,
      })) {
        throw new Error("제안 기준 revision 뒤 문서 내용 또는 서식이 변경되었습니다. 필드 제안을 다시 받아 주세요.");
      }
      applied = await transaction.apply({
        bytes: current.bytes,
        format: prepared.format,
        commandId: `field:${suggestion.id}`,
        binding: {
          target: run.target,
          beforeText: run.beforeText,
          beforeTextSha256: run.beforeTextSha256,
          formatSha256: run.formatSha256,
          adjacentContextSha256: run.adjacentContextSha256,
        },
        replacement: buildChoiceCellReplacement(run.beforeText, suggestion.value) ?? suggestion.value,
      });
      const materializedAnswers = { ...prepared.materializedAnswers, [run.fieldId]: suggestion.value };
      const persisted = await persistStudioSnapshot({
        draftId: transport.draftId,
        bytes: applied.bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount: applied.receipt.pageCountAfter,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: run.baseRevisionId,
        documentEpoch: applied.receipt.documentEpoch,
        changeSeq: applied.receipt.afterChangeSeq,
        origin: "studio_agent_apply",
        fieldAgentSuggestionId: suggestion.id,
        agentOperation: "apply",
        operationVersion: started.operationVersion,
        materializedAnswers,
        verification: fieldAgentVerification(applied, run, suggestion),
      });
      await acceptPersistedAgentSnapshot({
        bytes: applied.bytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: applied.receipt.afterChangeSeq,
        materializedAnswers,
      });
      toast.success(`'${run.fieldLabel}' 값을 문서의 정확한 입력 칸에 반영했습니다.`);
      const refreshed = await refreshFieldRun(run.id);
      await focusField(run.fieldId);
      return refreshed;
    } catch (error) {
      if (applied) {
        try {
          await transaction.revert({
            bytes: applied.bytes,
            format: prepared.format,
            commandId: `field:${suggestion.id}`,
            expectedAfterTextSha256: applied.receipt.afterTextSha256,
          });
          await notifyEditorSaved(editorRef.current!);
          if (started) {
            await transitionFieldAgentRunSuggestion({
              draftId: transport.draftId,
              suggestionId: suggestion.id,
              action: "abandon_apply",
              expectedStatusVersion: started.statusVersion,
              expectedOperationVersion: started.operationVersion,
              operationClientId,
              failureCode: "apply_rolled_back",
            }).catch(() => undefined);
          }
        } catch (rollbackError) {
          keepLocked = true;
          const message = `필드 적용 저장과 원상 복구를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`;
          setAgentHardLock(message);
          throw new Error(message);
        }
        throw new Error(`${errorMessage(error, "필드 값을 저장하지 못했습니다.")} 문서 변경은 원상 복구했습니다.`);
      }
      if (started) {
        await transitionFieldAgentRunSuggestion({
          draftId: transport.draftId,
          suggestionId: suggestion.id,
          action: "abandon_apply",
          expectedStatusVersion: started.statusVersion,
          expectedOperationVersion: started.operationVersion,
          operationClientId,
          failureCode: error instanceof StudioFieldAgentMutationVerificationError
            ? "core_validation_failed"
            : "revision_conflict",
        }).catch(() => undefined);
      }
      if (error instanceof StudioFieldAgentMutationVerificationError) {
        keepLocked = true;
        const detail = errorMessage(error.cause, error.message);
        const message = `Studio 필드 변경 결과를 검증하지 못해 편집을 잠갔습니다: ${detail} 최신 문서를 다시 불러와 주세요.`;
        setAgentHardLock(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      finishAgentMutation(keepLocked);
      setFieldAgentBusy(false);
    }
  }, [acceptPersistedAgentSnapshot, beginAgentMutation, finishAgentMutation, focusField, readCurrentFieldDocument, refreshFieldRun, transport]);

  const undoFieldSuggestion = useCallback(async (
    run: FieldAgentRunDto,
    suggestion: FieldAgentSuggestionDto,
  ): Promise<FieldAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    const transaction = fieldAgentTransactionRef.current;
    const prepared = preparedRef.current;
    if (!transaction || !prepared) throw new Error("현재 Studio에서 필드 Undo를 실행할 수 없습니다.");
    const operationClientId = crypto.randomUUID();
    let started: FieldAgentSuggestionDto | null = null;
    let reverted: Awaited<ReturnType<StudioFieldAgentTransaction["revert"]>> | null = null;
    let keepLocked = false;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      started = await transitionFieldAgentRunSuggestion({
        draftId: transport.draftId,
        suggestionId: suggestion.id,
        action: "authorize_undo",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
        operationClientId,
      });
      const current = await readCurrentFieldDocument();
      const appliedText = buildChoiceCellReplacement(run.beforeText, suggestion.value) ?? suggestion.value;
      reverted = await transaction.revert({
        bytes: current.bytes,
        format: prepared.format,
        commandId: `field:${suggestion.id}`,
        expectedAfterTextSha256: await sha256Hex(appliedText),
        ...(suggestion.appliedDocumentSha256 ? {
          recovery: {
            appliedDocumentSha256: suggestion.appliedDocumentSha256,
            appliedText,
            binding: {
              target: run.target,
              beforeText: run.beforeText,
              beforeTextSha256: run.beforeTextSha256,
              formatSha256: run.formatSha256,
              adjacentContextSha256: run.adjacentContextSha256,
            },
            ...(run.restoreFormat ? { restoreFormat: run.restoreFormat } : {}),
          },
        } : {}),
      });
      const materializedAnswers = { ...prepared.materializedAnswers };
      if (run.beforeAnswer?.value) materializedAnswers[run.fieldId] = run.beforeAnswer.value;
      else delete materializedAnswers[run.fieldId];
      const persisted = await persistStudioSnapshot({
        draftId: transport.draftId,
        bytes: reverted.bytes,
        filename: prepared.filename,
        format: prepared.format,
        pageCount: reverted.receipt.pageCountAfter,
        sessionId: studioSessionIdRef.current!,
        baseRevisionId: suggestion.appliedRevisionId,
        documentEpoch: reverted.receipt.documentEpoch,
        changeSeq: reverted.receipt.afterChangeSeq,
        origin: "studio_agent_undo",
        fieldAgentSuggestionId: suggestion.id,
        agentOperation: "undo",
        operationVersion: started.operationVersion,
        materializedAnswers,
        verification: fieldAgentVerification(reverted, run, suggestion),
      });
      await acceptPersistedAgentSnapshot({
        bytes: reverted.bytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: reverted.receipt.afterChangeSeq,
        materializedAnswers,
      });
      toast.success(`'${run.fieldLabel}'의 최근 AI 입력을 되돌렸습니다.`);
      return await refreshFieldRun(run.id);
    } catch (error) {
      if (started) {
        await transitionFieldAgentRunSuggestion({
          draftId: transport.draftId,
          suggestionId: suggestion.id,
          action: "abandon_undo",
          expectedStatusVersion: started.statusVersion,
          expectedOperationVersion: started.operationVersion,
          operationClientId,
          failureCode: reverted ? "undo_requires_reload" : "undo_conflict",
        }).catch(() => undefined);
      }
      if (reverted || error instanceof StudioFieldAgentMutationVerificationError) {
        keepLocked = true;
        const message = "필드 Undo 결과를 서버 revision으로 확정하지 못해 편집을 잠갔습니다. 최신 문서를 다시 불러와 주세요.";
        setAgentHardLock(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      finishAgentMutation(keepLocked);
      setFieldAgentBusy(false);
    }
  }, [acceptPersistedAgentSnapshot, beginAgentMutation, finishAgentMutation, readCurrentFieldDocument, refreshFieldRun, transport]);

  const dismissFieldSuggestion = useCallback(async (
    run: FieldAgentRunDto,
    suggestion: FieldAgentSuggestionDto,
  ): Promise<FieldAgentRunDto> => {
    if (transport.mode !== "persistent") throw new Error("서버 문서 초안이 아닙니다.");
    setFieldAgentBusy(true);
    try {
      await transitionFieldAgentRunSuggestion({
        draftId: transport.draftId,
        suggestionId: suggestion.id,
        action: "dismiss",
        expectedStatusVersion: suggestion.statusVersion,
        expectedOperationVersion: suggestion.operationVersion,
      });
      return await refreshFieldRun(run.id);
    } finally {
      setFieldAgentBusy(false);
    }
  }, [refreshFieldRun, transport]);

  useImperativeHandle(ref, () => ({
    saveAndReturn,
    focusField,
    prepareFieldWritingSession,
    requestFieldSuggestion,
    applyFieldSuggestion,
    undoFieldSuggestion,
    dismissFieldSuggestion,
  }), [
    applyFieldSuggestion,
    dismissFieldSuggestion,
    focusField,
    prepareFieldWritingSession,
    requestFieldSuggestion,
    saveAndReturn,
    undoFieldSuggestion,
  ]);

  const saving = isStudioSaveInFlight(saveState);
  const agentBusy = fieldAgentBusy
    || ["scanning", "checkpointing", "generating", "applying", "undoing"].includes(agentState.phase);

  return (
    <div className={cn(
      "flex min-h-0 flex-1 flex-col gap-3",
      presentation === "standalone" ? "p-3 lg:p-4" : "p-0",
    )}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-studio/30 bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-studio/35 bg-studio-soft text-studio">
              <FilePenLine data-icon="inline-start" aria-hidden />
              {presentation === "field_aware" ? "문서 편집" : "문서 직접 편집"}
            </Badge>
            {activeTask ? <strong className="truncate text-sm">현재 과제: {activeTask.label}</strong> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {localPreview
              ? "전체 문서를 직접 편집할 수 있어요. 변경사항은 이 탭에만 남고 서버에는 저장되지 않습니다."
              : "전체 문서를 직접 편집할 수 있어요. 지금 저장하면 검증된 작업본을 서버에 보관합니다."}
          </p>
          <StudioSaveIndicator state={saveState} className="mt-1" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {presentation === "standalone" && agentCapabilityReady && transport.mode === "persistent" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void openDocumentAgent()}
              disabled={state.status !== "ready" || saving || agentBusy || Boolean(agentHardLock)}
            >
              <WandSparkles data-icon="inline-start" aria-hidden />
              AI 작성 제안
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => void save("stay")}
            disabled={state.status !== "ready" || saving || agentBusy || Boolean(agentHardLock)}
          >
            {saving
              ? <Spinner data-icon="inline-start" />
              : <Save data-icon="inline-start" aria-hidden />}
            {saving
              ? "반영 중…"
              : saveState.kind === "error"
                ? localPreview ? "탭 반영 재시도" : "서버 저장 재시도"
                : localPreview ? "이 탭에 반영" : "지금 저장"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void downloadCurrentCopy()}
            disabled={state.status !== "ready" || saving || agentBusy || downloadBusy || Boolean(agentHardLock)}
          >
            {downloadBusy
              ? <Spinner data-icon="inline-start" />
              : <Download data-icon="inline-start" aria-hidden />}
            {downloadBusy ? "내보내는 중…" : "편집본 다운로드"}
          </Button>
          {presentation === "standalone" ? (
            <Button
              type="button"
              onClick={() => void saveAndReturn()}
              disabled={state.status !== "ready" || saving || agentBusy || Boolean(agentHardLock)}
            >
              {saving
                ? <Spinner data-icon="inline-start" />
                : <ArrowLeft data-icon="inline-start" aria-hidden />}
              {saving
                ? localPreview ? "이 탭에 반영 중…" : "서버에 저장 중…"
                : localPreview ? "반영하고 빠른 작성으로" : "저장하고 빠른 작성으로"}
            </Button>
          ) : null}
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
          <AlertTitle>
            {localPreview ? "Studio 작업본을 이 탭에 반영하지 못했습니다." : "Studio 작업본을 서버에 저장하지 못했습니다."}
          </AlertTitle>
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
              {localPreview ? "탭 반영 다시 시도" : "서버 저장 다시 시도"}
            </Button>
          </div>
        </Alert>
      ) : null}

      {agentHardLock ? (
        <Alert variant="destructive">
          <AlertTitle>문서 상태를 안전하게 확정하지 못해 편집을 잠갔습니다.</AlertTitle>
          <AlertDescription>{agentHardLock} 저장을 다시 누르지 말고 최신 문서를 새로 불러와 주세요.</AlertDescription>
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw data-icon="inline-start" aria-hidden />
              최신 문서 다시 불러오기
            </Button>
          </div>
        </Alert>
      ) : null}

      {state.status === "ready" && state.skipped.length > 0 ? (
        <Alert className="border-warning-strong/30 bg-warning-strong-soft">
          <AlertTitle>
            {presentation === "field_aware" ? "필드 값" : "빠른 작성 값"} {state.skipped.length.toLocaleString("ko-KR")}개는 자동 반영하지 않았어요.
          </AlertTitle>
          <AlertDescription>
            문서에서 직접 확인해 주세요: {state.skipped.map((entry) => entry.label).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="relative min-h-[68dvh] flex-1 overflow-hidden rounded-[var(--radius-xl)] border bg-card shadow-[var(--shadow-standard)]">
        {state.status === "loading" && state.allowEditorInteraction ? (
          <div className="pointer-events-none absolute top-3 left-1/2 z-10 w-[min(92%,42rem)] -translate-x-1/2 rounded-[var(--radius-lg)] border border-warning-strong/30 bg-card/95 px-3 py-2 text-center text-xs text-muted-foreground shadow-[var(--shadow-subtle)] backdrop-blur-sm">
            {state.message}
          </div>
        ) : state.status === "loading" || saving || agentBusy || agentHardLock ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-[var(--shadow-subtle)]">
              {agentHardLock ? <RefreshCw className="text-destructive" aria-hidden /> : <Spinner className="text-primary" />}
              {agentHardLock
                ? "안전을 위해 편집을 잠갔습니다. 최신 문서를 다시 불러와 주세요."
                : state.status === "loading"
                ? state.message
                : agentBusy
                  ? "문서 AI 작업을 검증하고 저장하고 있어요."
                : localPreview
                  ? "작업본을 검증해 이 브라우저 탭에 반영하고 있어요."
                  : "작업본을 검증해 서버에 저장하고 있어요."}
            </div>
          </div>
        ) : state.status === "ready" ? (
          <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full border bg-card/95 px-2.5 py-1 text-xs text-muted-foreground shadow-[var(--shadow-subtle)]">
            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
            {state.pageCount.toLocaleString("ko-KR")}쪽 열림
          </div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-[68dvh] w-full" aria-label="문서 직접 편집기" />
      </div>

      {presentation === "standalone" && agentCapabilityReady && transport.mode === "persistent" && state.status === "ready" ? (
        <DocumentAgentSheet
          state={agentState}
          pageCount={state.pageCount}
          onOpenChange={(open) => {
            if (!open) dispatchAgent({ type: "close" });
          }}
          onSelectPage={(page) => dispatchAgent({ type: "select_page", page, pageCount: state.pageCount })}
          onScan={() => void scanDocumentAgentPage()}
          onSelectCandidate={(candidateId) => dispatchAgent({ type: "select_candidate", candidateId })}
          onRequest={() => void requestAgentSuggestions()}
          onApply={(suggestionId) => void applyAgentSuggestion(suggestionId)}
          onDismiss={(suggestionId) => void dismissAgentSuggestion(suggestionId)}
          onUndo={(suggestionId) => void undoAgentSuggestion(suggestionId)}
          onRetry={() => dispatchAgent({ type: "retry" })}
          canUndoSuggestion={(suggestionId) => latestAppliedSuggestionIdRef.current === suggestionId}
        />
      ) : null}
    </div>
  );
});

RhwpStudioSurface.displayName = "RhwpStudioSurface";

type StudioAgentResult = Awaited<ReturnType<StudioCommandDocumentAgentTransaction["apply"]>>;
type StudioFieldAgentResult = Awaited<ReturnType<StudioFieldAgentTransaction["apply"]>>;

function agentVerification(result: StudioAgentResult, suggestionId: string): Record<string, unknown> {
  return {
    client: "rhwp-studio-command-v1",
    verified: true,
    operation: result.operation,
    suggestionId,
    commandId: result.studioReceipt.commandId,
    beforeDocumentSha256: result.beforeDocumentSha256,
    afterDocumentSha256: result.afterDocumentSha256,
    documentEpoch: result.studioReceipt.documentEpoch,
    afterChangeSeq: result.studioReceipt.afterChangeSeq,
    focusSucceeded: result.focus.focused,
    focusPage: result.focus.page,
  };
}

function fieldAgentVerification(
  result: StudioFieldAgentResult,
  run: FieldAgentRunDto,
  suggestion: FieldAgentSuggestionDto,
): Record<string, unknown> {
  return {
    client: "rhwp-studio-field-command-v1",
    verified: true,
    operation: result.receipt.operation,
    runId: run.id,
    suggestionId: suggestion.id,
    fieldId: run.fieldId,
    commandId: result.receipt.commandId,
    target: result.receipt.target,
    beforeDocumentSha256: result.beforeDocumentSha256,
    afterDocumentSha256: result.afterDocumentSha256,
    beforeTextSha256: result.receipt.beforeTextSha256,
    afterTextSha256: result.receipt.afterTextSha256,
    formatSha256: result.receipt.formatSha256,
    adjacentContextSha256: result.receipt.adjacentContextSha256,
    documentEpoch: result.receipt.documentEpoch,
    afterChangeSeq: result.receipt.afterChangeSeq,
  };
}

function replaceSuggestion(
  run: DocumentAgentRunDto,
  suggestion: DocumentAgentSuggestionDto,
): DocumentAgentRunDto {
  return {
    ...run,
    suggestions: run.suggestions.map((entry) => entry.id === suggestion.id ? suggestion : entry),
  };
}

function agentPersistenceFailureCode(
  error: unknown,
  undo = false,
): "snapshot_upload_failed" | "revision_conflict" | "undo_conflict" {
  if (error instanceof StudioSnapshotPersistenceError) {
    if (error.code === "revision_conflict") return undo ? "undo_conflict" : "revision_conflict";
    if (error.code === "snapshot_upload_failed" || error.status >= 500) return "snapshot_upload_failed";
  }
  return undo ? "undo_conflict" : "snapshot_upload_failed";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
