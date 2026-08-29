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
  type StudioBodyParagraphTargetV1,
  type StudioDocumentAgentProtocol,
  type StudioFieldAgentProtocol,
  type StudioFieldBindingTargetV1,
  type StudioFieldNavigationProtocol,
  type StudioFieldTargetV1,
} from "@/lib/rhwp/studioDocumentAgentProtocol";
import {
  buildStudioParagraphFieldReplacement,
  studioBodyParagraphTargetForField,
} from "@/lib/rhwp/studioParagraphFieldBindings";
import {
  resolveStudioFieldBindings,
  type StudioFieldBindingResolution,
} from "@/lib/rhwp/studioFieldBindings";
import {
  collectStudioFieldEvidenceBatch,
  createStudioFieldAgentTransaction,
  StudioFieldAgentMutationVerificationError,
  type StudioFieldAgentTransaction,
} from "@/lib/rhwp/studioFieldAgentTransaction";
import {
  createStudioProfileAutofillTransaction,
  StudioProfileAutofillTransactionError,
  type StudioProfileAutofillBatchResult,
} from "@/lib/rhwp/studioProfileAutofillTransaction";
import {
  matchesStudioFieldDocumentPreimage,
  studioFieldDocumentSemanticSha256,
} from "@/lib/rhwp/studioFieldDocumentManifest";
import {
  applyEmbeddedRhwpStudioPresentation,
  exportVerifiedEditorDocument,
  loadEditorFileWithoutDialogs,
  notifyEditorSaved,
  RHWP_STUDIO_URL,
} from "@/lib/rhwp/editorClient";
import {
  initialStudioSaveState,
  isStudioSaveInFlight,
  reduceStudioSaveState,
  type StudioSaveState,
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
import {
  applyScheduleTablePlan,
  inspectScheduleTableDocument,
  type ScheduleTableInspection,
  type ScheduleTableTarget,
} from "@/lib/rhwp/scheduleTable";
import type { ScheduleTablePlan } from "@/lib/rhwp/scheduleTableContract";
import { commitStudioSnapshot } from "@/lib/rhwp/studioTransport";
import { cn } from "@/lib/utils";
import {
  prepareRhwpWorkingDocument,
  sourceKeyForTransport,
  type RhwpWorkingDocument,
  type RhwpWorkingDocumentTransport,
} from "@/lib/rhwp/workingDocument";
import type { DocumentAuthoringTask } from "./documentAuthoring";
import type { ApplicationAutofillFieldBinding } from "@/lib/documents/applicationProfileAutofill";
import type {
  DocumentAgentRunDto,
  DocumentAgentSuggestionDto,
} from "@/lib/server/documents/documentAgentRuns";
import type {
  FieldAgentRunDto,
  FieldAgentSuggestionDto,
} from "@/lib/server/documents/fieldAgentRuns";
import { StudioSaveIndicator } from "./StudioSaveIndicator";
import { DocumentAgentPanel, DocumentAgentSheet } from "./DocumentAgentSheet";
import {
  initialDocumentAgentUiState,
  reduceDocumentAgentUiState,
} from "./documentAgentState";

type RhwpEditorInstance = import("@rhwp/editor").RhwpEditor;

export interface RhwpStudioSurfaceHandle {
  saveAndReturn(): Promise<void>;
  saveCurrent(): Promise<void>;
  downloadCurrentCopy(): Promise<void>;
  focusField(fieldId: string): Promise<boolean>;
  prepareFieldWritingSession(fieldId: string): Promise<PreparedFieldWritingSession>;
  requestFieldSuggestion(fieldId: string, sourceText?: string): Promise<FieldAgentRunDto>;
  applyFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
  undoFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
  dismissFieldSuggestion(run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto): Promise<FieldAgentRunDto>;
  inspectProfileAutofill(): Promise<ApplicationAutofillFieldBinding[]>;
  applyProfileAutofill(entries: readonly { fieldId: string; value: string }[]): Promise<{
    appliedCount: number;
    fieldIds: string[];
  }>;
  inspectScheduleTable(): Promise<ScheduleTableInspection>;
  applyScheduleTable(target: ScheduleTableTarget, plan: ScheduleTablePlan): Promise<{
    afterDocumentSha256: string;
  }>;
  undoScheduleTable(): Promise<void>;
  canUndoScheduleTable(): boolean;
}

export interface RhwpStudioDocumentActionState {
  saveState: StudioSaveState;
  saving: boolean;
  downloading: boolean;
  canSave: boolean;
  canDownload: boolean;
}

export interface PreparedFieldWritingSession {
  fieldId: string;
  baseRevisionId: string;
  target: StudioFieldBindingTargetV1;
}

type StudioFieldSelectionTargetV1 = StudioFieldTargetV1 | StudioBodyParagraphTargetV1;

type StudioState =
  | { status: "loading"; message: string; allowEditorInteraction?: boolean }
  | { status: "ready"; pageCount: number; skipped: RhwpWorkingDocument["skipped"] }
  | { status: "error"; message: string };

type StudioSaveIntent = "auto" | "stay" | "return";

interface ScheduleTableUndoState {
  beforeBytes: Uint8Array;
  beforeDocumentSha256: string;
  afterDocumentSha256: string;
  appliedRevisionId: string;
  pageCountBefore: number;
}

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
  presentation?: "standalone" | "field_aware" | "document_guided";
  onDocumentActionStateChanged?: (state: RhwpStudioDocumentActionState) => void;
  onFieldBindingsResolved?: (resolutions: readonly StudioFieldBindingResolution[]) => void;
  onFieldSelectionChanged?: (target: StudioFieldSelectionTargetV1 | null) => void;
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
  onDocumentActionStateChanged,
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
  const [showDocumentAgentSheet, setShowDocumentAgentSheet] = useState(false);
  const [agentHardLock, setAgentHardLock] = useState<string | null>(null);
  const [fieldAgentBusy, setFieldAgentBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<RhwpEditorInstance | null>(null);
  const saveProtocolRef = useRef<RhwpStudioSaveProtocol | null>(null);
  const agentTransactionRef = useRef<StudioCommandDocumentAgentTransaction | null>(null);
  const fieldAgentTransactionRef = useRef<StudioFieldAgentTransaction | null>(null);
  const fieldAgentProtocolRef = useRef<StudioFieldAgentProtocol | null>(null);
  const documentAgentProtocolRef = useRef<StudioDocumentAgentProtocol | null>(null);
  const fieldNavigationProtocolRef = useRef<StudioFieldNavigationProtocol | null>(null);
  const fieldTargetsRef = useRef<Map<string, StudioFieldBindingTargetV1>>(new Map());
  const agentCandidatesRef = useRef<DocumentEditCandidate[]>([]);
  const agentReservedAnchorsRef = useRef<DocumentAgentReservedAnchor[]>([]);
  const latestAppliedSuggestionIdRef = useRef<string | null>(null);
  const documentAgentInitializedRef = useRef(false);
  const scheduleTableUndoRef = useRef<ScheduleTableUndoState | null>(null);
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
    let paragraphSelectionPoll: ReturnType<typeof setInterval> | null = null;
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
          try {
            await applyEmbeddedRhwpStudioPresentation(candidate);
          } catch (error) {
            console.warn("rhwp Studio 밝은 플랫 스킨 적용 실패", error);
          }
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
      documentAgentProtocolRef.current = agentProtocol;
      if (presentation === "field_aware" && agentProtocol
          && [...fieldTargetsRef.current.values()].some((target) => target.kind === "body_paragraph_text")) {
        let pollBusy = false;
        const publishParagraphSelection = async () => {
          if (pollBusy || disposed || requestSeq.current !== seq || document.visibilityState === "hidden") return;
          pollBusy = true;
          try {
            const selection = await agentProtocol.getSelectionContext();
            if (selection.editable && selection.target) {
              onFieldSelectionChangedRef.current?.(selection.target);
            }
          } catch {
            // selection polling 실패는 문서 편집과 native table field selection을 막지 않는다.
          } finally {
            pollBusy = false;
          }
        };
        void publishParagraphSelection();
        paragraphSelectionPoll = setInterval(() => void publishParagraphSelection(), 400);
      }
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
      fieldAgentProtocolRef.current = presentation === "field_aware" && transport.mode === "persistent"
        ? fieldAgentProtocol
        : null;
      if (
        fieldEditorAgentAvailable
        && presentation === "field_aware"
        && transport.mode === "persistent"
        && (fieldAgentProtocol || agentProtocol)
      ) {
        const rhwp = await loadRhwp();
        fieldAgentTransactionRef.current = createStudioFieldAgentTransaction({
          rhwp,
          fieldProtocol: fieldAgentProtocol,
          documentProtocol: agentProtocol,
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
        scheduleTableUndoRef.current = null;
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
      if (paragraphSelectionPoll) clearInterval(paragraphSelectionPoll);
      editorRef.current?.destroy();
      editorRef.current = null;
      saveProtocolRef.current = null;
      agentTransactionRef.current = null;
      fieldAgentTransactionRef.current = null;
      fieldAgentProtocolRef.current = null;
      documentAgentProtocolRef.current = null;
      fieldNavigationProtocolRef.current = null;
      fieldTargetsRef.current = new Map();
      agentCandidatesRef.current = [];
      agentReservedAnchorsRef.current = [];
      latestAppliedSuggestionIdRef.current = null;
      scheduleTableUndoRef.current = null;
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

  const saveCurrent = useCallback(async () => {
    await save("stay");
  }, [save]);

  const focusField = useCallback(async (fieldId: string): Promise<boolean> => {
    const target = fieldTargetsRef.current.get(fieldId);
    if (!target) return false;
    try {
      const result = target.kind === "body_paragraph_text"
        ? await documentAgentProtocolRef.current?.focusTarget(studioBodyParagraphTargetForField(target))
        : await fieldNavigationProtocolRef.current?.focusFieldTarget(target);
      if (!result) return false;
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

  const initializeDocumentAgent = useCallback(async () => {
    if (!agentCapabilityReady || state.status !== "ready" || transport.mode !== "persistent") return;
    if (documentAgentInitializedRef.current) return;
    documentAgentInitializedRef.current = true;
    dispatchAgent({ type: "open", pageCount: state.pageCount });
    try {
      const [recent] = await fetchDocumentAgentRuns(transport.draftId);
      if (recent) dispatchAgent({ type: "history_loaded", run: recent });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "최근 문서 제안을 불러오지 못했습니다.");
    }
  }, [agentCapabilityReady, state, transport]);

  const openDocumentAgent = useCallback(async () => {
    await initializeDocumentAgent();
    setShowDocumentAgentSheet(true);
  }, [initializeDocumentAgent]);

  useEffect(() => {
    if (presentation !== "document_guided") return;
    void initializeDocumentAgent();
  }, [initializeDocumentAgent, presentation]);

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
        replacement: run.target.kind === "body_paragraph_text"
          ? buildStudioParagraphFieldReplacement(run.beforeText, run.target, suggestion.value)
          : buildChoiceCellReplacement(run.beforeText, suggestion.value) ?? suggestion.value,
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
      const appliedText = run.target.kind === "body_paragraph_text"
        ? buildStudioParagraphFieldReplacement(run.beforeText, run.target, suggestion.value)
        : buildChoiceCellReplacement(run.beforeText, suggestion.value) ?? suggestion.value;
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

  const inspectProfileAutofill = useCallback(async (): Promise<ApplicationAutofillFieldBinding[]> => {
    let locked = false;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      locked = true;
      const current = await readCurrentFieldDocument();
      onFieldBindingsResolvedRef.current?.(current.resolutions);
      const rhwp = await loadRhwp();
      const bindings: ApplicationAutofillFieldBinding[] = [];
      const uniqueResolutions = current.resolutions.filter((resolution) => resolution.status === "unique");
      const evidence = await collectStudioFieldEvidenceBatch(
        rhwp,
        current.bytes,
        uniqueResolutions.map((resolution) => resolution.target),
      );
      const evidenceByFieldId = new Map(uniqueResolutions.map((resolution, index) => [
        resolution.fieldId,
        evidence[index] ?? null,
      ]));
      for (const resolution of current.resolutions) {
        if (resolution.status !== "unique") {
          bindings.push({ fieldId: resolution.fieldId, status: resolution.status });
          continue;
        }
        const fieldEvidence = evidenceByFieldId.get(resolution.fieldId);
        if (fieldEvidence) {
          bindings.push({
            fieldId: resolution.fieldId,
            status: "unique",
            beforeText: fieldEvidence.text,
          });
        } else {
          bindings.push({ fieldId: resolution.fieldId, status: "missing" });
        }
      }
      return bindings;
    } finally {
      if (locked) finishAgentMutation();
      setFieldAgentBusy(false);
    }
  }, [beginAgentMutation, finishAgentMutation, readCurrentFieldDocument]);

  const applyProfileAutofill = useCallback(async (
    entries: readonly { fieldId: string; value: string }[],
  ): Promise<{ appliedCount: number; fieldIds: string[] }> => {
    if (transport.mode !== "persistent") throw new Error("서버에 저장되는 문서 초안이 아닙니다.");
    if (entries.length === 0) return { appliedCount: 0, fieldIds: [] };
    if (entries.length > 100) throw new Error("한 번에 입력할 수 있는 등록정보 필드 수를 초과했습니다.");
    const prepared = preparedRef.current;
    const editor = editorRef.current;
    const protocol = fieldAgentProtocolRef.current;
    if (!prepared || !editor || !protocol) {
      throw new Error("현재 문서에서 등록정보 일괄 입력을 실행할 수 없습니다.");
    }

    let locked = false;
    let keepLocked = false;
    let batchResult: StudioProfileAutofillBatchResult | null = null;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      locked = true;
      const current = await readCurrentFieldDocument();
      const fieldById = new Map(connectedFields.map((field) => [field.fieldId, field]));
      const resolutionById = new Map(current.resolutions.map((resolution) => [resolution.fieldId, resolution]));
      const requestedIds = new Set<string>();
      const batchEntries = entries.map((entry) => {
        if (requestedIds.has(entry.fieldId)) throw new Error("일괄 입력 대상 fieldId가 중복되었습니다.");
        requestedIds.add(entry.fieldId);
        const field = fieldById.get(entry.fieldId);
        const resolution = resolutionById.get(entry.fieldId);
        if (!field || !resolution || resolution.status !== "unique") {
          throw new Error("현재 revision에서 모든 일괄 입력 위치를 하나씩 확정하지 못했습니다.");
        }
        if (resolution.target.kind === "body_paragraph_text") {
          throw new Error("표 밖 문단 필드는 AI 작성 가이드에서 개별 확인 후 반영해 주세요.");
        }
        return {
          fieldId: field.fieldId,
          label: field.label,
          sourceSpan: field.sourceSpan ?? null,
          target: resolution.target,
          value: entry.value,
        };
      });

      const rhwp = await loadRhwp();
      const transaction = createStudioProfileAutofillTransaction({
        rhwp,
        protocol,
        exportCurrentBytes: (format) => exportVerifiedEditorDocument(editor, format),
      });
      try {
        batchResult = await transaction.apply({
          bytes: current.bytes,
          format: prepared.format,
          entries: batchEntries,
        });
      } catch (error) {
        if (error instanceof StudioProfileAutofillTransactionError) {
          if (error.mutationUncertain) {
            keepLocked = true;
            throw new Error("일괄 입력 결과를 검증하지 못해 편집을 잠갔습니다. 최신 문서를 다시 불러와 주세요.");
          }
          if (error.partial && error.partial.applied.length > 0) {
            try {
              await transaction.revert(error.partial);
              await notifyEditorSaved(editor);
            } catch (rollbackError) {
              keepLocked = true;
              throw new Error(`일괄 입력 복구를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`);
            }
            throw new Error(`${error.message} 앞서 입력한 값은 원상 복구했습니다.`);
          }
        }
        throw error;
      }

      const lastApplied = batchResult.applied.at(-1);
      if (!lastApplied) return { appliedCount: 0, fieldIds: [] };
      const materializedAnswers = { ...prepared.materializedAnswers };
      for (const entry of batchResult.applied) materializedAnswers[entry.fieldId] = entry.value;

      let persisted: Awaited<ReturnType<typeof persistStudioSnapshot>>;
      try {
        persisted = await persistStudioSnapshot({
          draftId: transport.draftId,
          bytes: batchResult.bytes,
          filename: prepared.filename,
          format: prepared.format,
          pageCount: lastApplied.result.receipt.pageCountAfter,
          sessionId: studioSessionIdRef.current!,
          baseRevisionId: prepared.revisionId,
          documentEpoch: lastApplied.result.receipt.documentEpoch,
          changeSeq: lastApplied.result.receipt.afterChangeSeq,
          origin: "studio_manual",
          materializedAnswers,
          verification: {
            client: "rhwp-core-reopen",
            verified: true,
            purpose: "application_profile_autofill",
            beforeDocumentSha256: current.documentSha256,
            afterDocumentSha256: lastApplied.result.afterDocumentSha256,
            fields: batchResult.applied.map((entry) => ({
              fieldId: entry.fieldId,
              beforeTextSha256: entry.binding.beforeTextSha256,
              afterTextSha256: entry.result.receipt.afterTextSha256,
            })),
          },
        });
      } catch (error) {
        try {
          await transaction.revert(batchResult);
          await notifyEditorSaved(editor);
        } catch (rollbackError) {
          keepLocked = true;
          throw new Error(`등록정보 입력 저장과 원상 복구를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`);
        }
        throw new Error(`${errorMessage(error, "등록정보를 입력한 문서를 저장하지 못했습니다.")} 문서 변경은 원상 복구했습니다.`);
      }

      try {
        await acceptPersistedAgentSnapshot({
          bytes: batchResult.bytes,
          revisionId: persisted.revisionId,
          savedAt: persisted.savedAt,
          changeSeq: lastApplied.result.receipt.afterChangeSeq,
          materializedAnswers,
        });
      } catch (error) {
        keepLocked = true;
        throw new Error(`서버 저장 뒤 현재 편집 상태를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(error, "상태 반영 실패")}`);
      }
      onFieldBindingsResolvedRef.current?.(current.resolutions);
      await focusField(lastApplied.fieldId);
      return {
        appliedCount: batchResult.applied.length,
        fieldIds: batchResult.applied.map((entry) => entry.fieldId),
      };
    } finally {
      if (locked) finishAgentMutation(keepLocked);
      setFieldAgentBusy(false);
    }
  }, [
    acceptPersistedAgentSnapshot,
    beginAgentMutation,
    connectedFields,
    finishAgentMutation,
    focusField,
    readCurrentFieldDocument,
    transport,
  ]);

  const readCurrentScheduleDocument = useCallback(async () => {
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
        pageCount: document.pageCount(),
        inspection: await inspectScheduleTableDocument(document, documentSha256),
      };
    } finally {
      document.free();
    }
  }, []);

  const loadScheduleBytesIntoEditor = useCallback(async (bytes: Uint8Array) => {
    const editor = editorRef.current;
    const prepared = preparedRef.current;
    if (!editor || !prepared) throw new Error("현재 Studio 작업본을 찾지 못했습니다.");
    const result = await loadEditorFileWithoutDialogs(editor, bytes.slice(), prepared.filename);
    clearAutosaveTimers();
    const dirtyStateRequest = saveProtocolRef.current?.getDirtyState() ?? null;
    const dirtyState = dirtyStateRequest ? await dirtyStateRequest.catch(() => null) : null;
    const documentEpoch = dirtyState?.documentEpoch ?? documentEpochRef.current;
    const changeSeq = dirtyState?.changeSeq ?? legacySaveSeqRef.current + 1;
    documentEpochRef.current = documentEpoch;
    latestChangeSeqRef.current = dirtyState?.changeSeq ?? null;
    setState({ status: "ready", pageCount: result.pageCount, skipped: prepared.skipped });

    try {
      const rhwp = await loadRhwp();
      const reopened = new rhwp.HwpDocument(bytes);
      try {
        const resolutions = resolveStudioFieldBindings(reopened, connectedFields);
        for (const resolution of resolutions) {
          if (resolution.status === "unique") fieldTargetsRef.current.set(resolution.fieldId, resolution.target);
          else fieldTargetsRef.current.delete(resolution.fieldId);
        }
        onFieldBindingsResolvedRef.current?.(resolutions);
      } finally {
        reopened.free();
      }
    } catch (error) {
      fieldTargetsRef.current = new Map();
      onFieldBindingsResolvedRef.current?.([]);
      console.warn("일정표 반영 뒤 필드 위치 재탐색 실패", error);
    }
    return { pageCount: result.pageCount, documentEpoch, changeSeq };
  }, [clearAutosaveTimers, connectedFields]);

  const inspectScheduleTable = useCallback(async (): Promise<ScheduleTableInspection> => {
    if (transport.mode !== "persistent") throw new Error("서버에 저장되는 문서 초안이 아닙니다.");
    let locked = false;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      locked = true;
      const current = await readCurrentScheduleDocument();
      return current.inspection;
    } finally {
      if (locked) finishAgentMutation();
      setFieldAgentBusy(false);
    }
  }, [beginAgentMutation, finishAgentMutation, readCurrentScheduleDocument, transport]);

  const applyScheduleTable = useCallback(async (
    target: ScheduleTableTarget,
    plan: ScheduleTablePlan,
  ): Promise<{ afterDocumentSha256: string }> => {
    if (transport.mode !== "persistent") throw new Error("서버에 저장되는 문서 초안이 아닙니다.");
    const prepared = preparedRef.current;
    const editor = editorRef.current;
    if (!prepared || !editor) throw new Error("현재 문서에서 일정표 자동 입력을 실행할 수 없습니다.");

    let locked = false;
    let keepLocked = false;
    let editorLoaded = false;
    let current: Awaited<ReturnType<typeof readCurrentScheduleDocument>> | null = null;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      locked = true;
      current = await readCurrentScheduleDocument();
      const rhwp = await loadRhwp();
      const applied = await applyScheduleTablePlan({
        rhwp,
        bytes: current.bytes,
        format: prepared.format,
        target,
        plan,
      });

      editorLoaded = true;
      let loaded: Awaited<ReturnType<typeof loadScheduleBytesIntoEditor>>;
      try {
        loaded = await loadScheduleBytesIntoEditor(applied.bytes);
      } catch (error) {
        try {
          await loadScheduleBytesIntoEditor(current.bytes);
          await notifyEditorSaved(editor);
          editorLoaded = false;
        } catch (rollbackError) {
          keepLocked = true;
          throw new Error(`일정표 적용본을 편집기에 불러오지 못했고 원본 복구도 확정하지 못했습니다: ${errorMessage(rollbackError, "복구 실패")}`);
        }
        throw new Error(`${errorMessage(error, "일정표 적용본을 편집기에 불러오지 못했습니다.")} 문서는 원상 복구했습니다.`);
      }
      let persisted: Awaited<ReturnType<typeof persistStudioSnapshot>>;
      try {
        persisted = await persistStudioSnapshot({
          draftId: transport.draftId,
          bytes: applied.bytes,
          filename: prepared.filename,
          format: prepared.format,
          pageCount: loaded.pageCount,
          sessionId: studioSessionIdRef.current!,
          baseRevisionId: prepared.revisionId,
          documentEpoch: loaded.documentEpoch,
          changeSeq: loaded.changeSeq,
          origin: "studio_manual",
          materializedAnswers: prepared.materializedAnswers,
          verification: {
            client: "rhwp-core-reopen",
            verified: true,
            purpose: "schedule_table_apply",
            beforeDocumentSha256: applied.beforeDocumentSha256,
            afterDocumentSha256: applied.afterDocumentSha256,
            structureSha256: target.structureSha256,
            preimageSha256: target.preimageSha256,
            phases: plan.phases.map((phase) => ({
              title: phase.title,
              startMonth: phase.startMonth,
              endMonth: phase.endMonth,
              basisKind: phase.basisKind,
            })),
          },
        });
      } catch (error) {
        try {
          await loadScheduleBytesIntoEditor(current.bytes);
          await notifyEditorSaved(editor);
        } catch (rollbackError) {
          keepLocked = true;
          throw new Error(`일정표 저장과 원상 복구를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`);
        }
        editorLoaded = false;
        throw new Error(`${errorMessage(error, "일정표를 반영한 문서를 저장하지 못했습니다.")} 문서 변경은 원상 복구했습니다.`);
      }

      if (!(saveProtocolRef.current?.supportsChangeEvents ?? false)) legacySaveSeqRef.current = loaded.changeSeq;
      await acceptPersistedAgentSnapshot({
        bytes: applied.bytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: loaded.changeSeq,
      });
      scheduleTableUndoRef.current = {
        beforeBytes: current.bytes,
        beforeDocumentSha256: current.documentSha256,
        afterDocumentSha256: applied.afterDocumentSha256,
        appliedRevisionId: persisted.revisionId,
        pageCountBefore: current.pageCount,
      };
      return { afterDocumentSha256: applied.afterDocumentSha256 };
    } catch (error) {
      if (editorLoaded) {
        keepLocked = true;
        const message = `일정표 자동 입력 뒤 현재 편집 상태를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(error, "상태 반영 실패")}`;
        setAgentHardLock(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      if (locked) finishAgentMutation(keepLocked);
      setFieldAgentBusy(false);
    }
  }, [
    acceptPersistedAgentSnapshot,
    beginAgentMutation,
    finishAgentMutation,
    loadScheduleBytesIntoEditor,
    readCurrentScheduleDocument,
    transport,
  ]);

  const undoScheduleTable = useCallback(async (): Promise<void> => {
    if (transport.mode !== "persistent") throw new Error("서버에 저장되는 문서 초안이 아닙니다.");
    const undo = scheduleTableUndoRef.current;
    const prepared = preparedRef.current;
    const editor = editorRef.current;
    if (!undo || !prepared || !editor) throw new Error("이 Studio 세션에서 되돌릴 최근 일정표 입력이 없습니다.");

    let locked = false;
    let keepLocked = false;
    let editorLoaded = false;
    setFieldAgentBusy(true);
    try {
      beginAgentMutation();
      locked = true;
      const current = await readCurrentScheduleDocument();
      if (current.documentSha256 !== undo.afterDocumentSha256) {
        scheduleTableUndoRef.current = null;
        throw new Error("일정표 입력 뒤 문서가 변경되어 전체 문서 Undo를 차단했습니다.");
      }
      if (await sha256Hex(undo.beforeBytes) !== undo.beforeDocumentSha256) {
        scheduleTableUndoRef.current = null;
        throw new Error("저장해 둔 일정표 입력 전 문서가 손상되어 Undo를 차단했습니다.");
      }

      editorLoaded = true;
      let loaded: Awaited<ReturnType<typeof loadScheduleBytesIntoEditor>>;
      try {
        loaded = await loadScheduleBytesIntoEditor(undo.beforeBytes);
      } catch (error) {
        try {
          await loadScheduleBytesIntoEditor(current.bytes);
          await notifyEditorSaved(editor);
          editorLoaded = false;
        } catch (rollbackError) {
          keepLocked = true;
          throw new Error(`일정표 Undo 문서를 편집기에 불러오지 못했고 적용본 복구도 확정하지 못했습니다: ${errorMessage(rollbackError, "복구 실패")}`);
        }
        throw new Error(`${errorMessage(error, "일정표 Undo 문서를 편집기에 불러오지 못했습니다.")} 문서는 적용 상태로 복구했습니다.`);
      }
      let persisted: Awaited<ReturnType<typeof persistStudioSnapshot>>;
      try {
        persisted = await persistStudioSnapshot({
          draftId: transport.draftId,
          bytes: undo.beforeBytes,
          filename: prepared.filename,
          format: prepared.format,
          pageCount: undo.pageCountBefore,
          sessionId: studioSessionIdRef.current!,
          baseRevisionId: undo.appliedRevisionId,
          documentEpoch: loaded.documentEpoch,
          changeSeq: loaded.changeSeq,
          origin: "studio_manual",
          materializedAnswers: prepared.materializedAnswers,
          verification: {
            client: "rhwp-core-reopen",
            verified: true,
            purpose: "schedule_table_undo",
            beforeDocumentSha256: current.documentSha256,
            afterDocumentSha256: undo.beforeDocumentSha256,
          },
        });
      } catch (error) {
        try {
          await loadScheduleBytesIntoEditor(current.bytes);
          await notifyEditorSaved(editor);
        } catch (rollbackError) {
          keepLocked = true;
          throw new Error(`일정표 Undo 저장과 적용본 복구를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(rollbackError, "복구 실패")}`);
        }
        editorLoaded = false;
        throw new Error(`${errorMessage(error, "일정표 Undo 문서를 저장하지 못했습니다.")} 문서는 적용 상태로 복구했습니다.`);
      }

      if (!(saveProtocolRef.current?.supportsChangeEvents ?? false)) legacySaveSeqRef.current = loaded.changeSeq;
      await acceptPersistedAgentSnapshot({
        bytes: undo.beforeBytes,
        revisionId: persisted.revisionId,
        savedAt: persisted.savedAt,
        changeSeq: loaded.changeSeq,
      });
      scheduleTableUndoRef.current = null;
    } catch (error) {
      if (editorLoaded) {
        keepLocked = true;
        const message = `일정표 Undo 뒤 현재 편집 상태를 확정하지 못해 편집을 잠갔습니다: ${errorMessage(error, "상태 반영 실패")}`;
        setAgentHardLock(message);
        throw new Error(message);
      }
      throw error;
    } finally {
      if (locked) finishAgentMutation(keepLocked);
      setFieldAgentBusy(false);
    }
  }, [
    acceptPersistedAgentSnapshot,
    beginAgentMutation,
    finishAgentMutation,
    loadScheduleBytesIntoEditor,
    readCurrentScheduleDocument,
    transport,
  ]);

  const canUndoScheduleTable = useCallback(() => scheduleTableUndoRef.current !== null, []);

  useImperativeHandle(ref, () => ({
    saveAndReturn,
    saveCurrent,
    downloadCurrentCopy,
    focusField,
    prepareFieldWritingSession,
    requestFieldSuggestion,
    applyFieldSuggestion,
    undoFieldSuggestion,
    dismissFieldSuggestion,
    inspectProfileAutofill,
    applyProfileAutofill,
    inspectScheduleTable,
    applyScheduleTable,
    undoScheduleTable,
    canUndoScheduleTable,
  }), [
    applyProfileAutofill,
    applyScheduleTable,
    applyFieldSuggestion,
    dismissFieldSuggestion,
    downloadCurrentCopy,
    focusField,
    inspectProfileAutofill,
    inspectScheduleTable,
    prepareFieldWritingSession,
    requestFieldSuggestion,
    saveAndReturn,
    saveCurrent,
    undoFieldSuggestion,
    undoScheduleTable,
    canUndoScheduleTable,
  ]);

  const saving = isStudioSaveInFlight(saveState);
  const agentBusy = fieldAgentBusy
    || ["scanning", "checkpointing", "generating", "applying", "undoing"].includes(agentState.phase);
  const documentActionsBlocked = agentBusy || Boolean(agentHardLock);

  useEffect(() => {
    if (presentation !== "field_aware") return;
    onDocumentActionStateChanged?.({
      saveState,
      saving,
      downloading: downloadBusy,
      canSave: state.status === "ready" && !saving && !documentActionsBlocked,
      canDownload: state.status === "ready" && !saving && !downloadBusy && !documentActionsBlocked,
    });
  }, [
    documentActionsBlocked,
    downloadBusy,
    onDocumentActionStateChanged,
    presentation,
    saveState,
    saving,
    state.status,
  ]);

  const documentAgentPageCount = state.status === "ready" ? state.pageCount : 1;
  const documentAgentReady = documentAgentAvailable
    && transport.mode === "persistent"
    && agentCapabilityReady
    && agentState.phase !== "closed"
    && state.status === "ready";
  const documentAgentUnavailableMessage = localPreview
    ? "읽기 전용 시뮬레이션에서는 LLM 제안을 실행하지 않습니다. 실제 회사 초안에서 공고 근거와 현재 문서 문맥을 사용한 제안을 요청할 수 있습니다."
    : !documentAgentAvailable
      ? "AI 작성 가이드가 아직 활성화되지 않았습니다. RHWP 수동 편집과 저장·다운로드는 계속 사용할 수 있습니다."
      : state.status !== "ready"
        ? "RHWP 문서를 준비한 뒤 작성 위치와 가이드를 연결합니다."
        : "현재 편집기에서 안전한 문단·셀 선택 기능을 확인하지 못했습니다. 수동 편집은 계속할 수 있습니다.";
  const documentAgentControls = {
    state: agentState,
    pageCount: documentAgentPageCount,
    onSelectPage: (page: number) => dispatchAgent({ type: "select_page", page, pageCount: documentAgentPageCount }),
    onScan: () => void scanDocumentAgentPage(),
    onSelectCandidate: (candidateId: string) => dispatchAgent({ type: "select_candidate", candidateId }),
    onRequest: () => void requestAgentSuggestions(),
    onApply: (suggestionId: string) => void applyAgentSuggestion(suggestionId),
    onDismiss: (suggestionId: string) => void dismissAgentSuggestion(suggestionId),
    onUndo: (suggestionId: string) => void undoAgentSuggestion(suggestionId),
    onRetry: () => dispatchAgent({ type: "retry" }),
    canUndoSuggestion: (suggestionId: string) => latestAppliedSuggestionIdRef.current === suggestionId,
  };
  const guidedDocumentActions = {
    saveState,
    saving,
    downloading: downloadBusy,
    canSave: state.status === "ready" && !saving && !documentActionsBlocked,
    canDownload: state.status === "ready" && !saving && !downloadBusy && !documentActionsBlocked,
    onSave: () => void saveCurrent(),
    onDownload: () => void downloadCurrentCopy(),
    saveLabel: localPreview ? "이 탭에 반영" : "지금 저장",
  };

  return (
    <div className={cn(
      "flex min-h-0 flex-1 flex-col gap-3",
      presentation === "standalone" ? "p-3 lg:p-4" : "p-0",
    )}>
      {presentation === "standalone" ? (
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
            {localPreview
              ? "전체 문서를 직접 편집할 수 있어요. 변경사항은 이 탭에만 남고 서버에는 저장되지 않습니다."
              : "전체 문서를 직접 편집할 수 있어요. 지금 저장하면 검증된 작업본을 서버에 보관합니다."}
          </p>
          <StudioSaveIndicator state={saveState} className="mt-1" />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {agentCapabilityReady && transport.mode === "persistent" ? (
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
        </div>
        </div>
      ) : null}

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
            연결된 입력 값 {state.skipped.length.toLocaleString("ko-KR")}개는 자동 반영하지 않았어요.
          </AlertTitle>
          <AlertDescription>
            문서에서 직접 확인해 주세요: {state.skipped.map((entry) => entry.label).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className={cn(
        "flex min-h-0 flex-1",
        presentation === "document_guided"
          && "grid gap-4 overflow-auto xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden",
      )}>
        <div className="relative min-h-[68dvh] min-w-0 flex-1 overflow-hidden rounded-[var(--radius-xl)] border-[1.5px] border-input bg-card shadow-[var(--shadow-standard)]">
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

        {presentation === "document_guided" ? (
          <div className="hidden h-full min-h-0 overflow-hidden xl:block">
            <DocumentAgentPanel
              {...documentAgentControls}
              available={documentAgentReady}
              unavailableMessage={documentAgentUnavailableMessage}
              documentActions={guidedDocumentActions}
            />
          </div>
        ) : null}
      </div>

      {presentation === "document_guided" ? (
        <div className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-3 rounded-xl border bg-background/95 p-2.5 shadow-lg backdrop-blur xl:hidden">
          <div className="min-w-0 flex-1 px-1">
            <p className="text-[11px] font-medium text-muted-foreground">현재 문서</p>
            <p className="truncate text-sm font-semibold">공고 근거 기반 작성 가이드</p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={state.status !== "ready"}
            onClick={() => {
              if (documentAgentReady) void openDocumentAgent();
              else setShowDocumentAgentSheet(true);
            }}
          >
            <WandSparkles data-icon="inline-start" aria-hidden />
            AI 작성 가이드
          </Button>
        </div>
      ) : null}

      {(presentation === "standalone" || presentation === "document_guided") && state.status === "ready" ? (
        <DocumentAgentSheet
          {...documentAgentControls}
          open={showDocumentAgentSheet}
          onOpenChange={setShowDocumentAgentSheet}
          available={presentation === "standalone" ? true : documentAgentReady}
          unavailableMessage={documentAgentUnavailableMessage}
          documentActions={presentation === "document_guided" ? guidedDocumentActions : undefined}
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
