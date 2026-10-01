"use client";

/**
 * RHWP 작성 workspace 오케스트레이터.
 * HWP/HWPX는 필드 결속 유무와 관계없이 RHWP + 우측 AI 작성 가이드로 열고,
 * RHWP 비지원 문서만 채팅 fallback으로 보낸다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, MessageSquare, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { extractFieldOptions } from "@/lib/documents/fieldOptions";
import {
  acceptAutomaticProfileAutofillAnswers,
  buildAutomaticProfileAutofillEntries,
  undoAutomaticProfileAutofillAnswers,
  type AutomaticProfileAutofillEntry,
} from "@/lib/documents/applicationProfileAutofill";
import type {
  RhwpFieldAnchor,
  RhwpFieldDescriptor,
} from "@/lib/rhwp/fieldAnchors";
import {
  sourceKeyForTransport,
  type RhwpWorkingDocument,
  type RhwpWorkingDocumentTransport,
} from "@/lib/rhwp/workingDocument";
import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { FieldAgentRunDto, FieldAgentSuggestionDto } from "@/lib/server/documents/fieldAgentRuns";
import { fetchFieldAgentRuns } from "@/lib/rhwp/fieldAgentApi";
import type {
  StudioBodyParagraphTargetV1,
  StudioFieldBindingTargetV1,
  StudioFieldTargetV1,
} from "@/lib/rhwp/studioDocumentAgentProtocol";
import type { StudioFieldBindingResolution } from "@/lib/rhwp/studioFieldBindings";
import type { ScheduleTableTarget } from "@/lib/rhwp/scheduleTable";
import type { ScheduleTablePlan } from "@/lib/rhwp/scheduleTableContract";
import { initialStudioSaveState } from "@/lib/rhwp/studioSaveState";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { WorkspaceData } from "@/lib/server/documents/workspaceData";
import type { ChatMessageContent } from "@/lib/chat/messageContent";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { answerKey } from "./fieldAnswerState";
import { ChatPanelView, useGrantChat } from "./ChatPanel";
import { buildDocumentAuthoringTasks } from "./documentAuthoring";
import { FieldAgentRail } from "./FieldAgentRail";
import { buildFieldAwareDocumentSession, fieldSelectionTargetKey } from "./fieldAwareDocumentSession";
import {
  RhwpStudioSurface,
  type RhwpStudioDocumentActionState,
  type RhwpStudioSurfaceHandle,
} from "./RhwpStudioSurface";
import type { InstitutionContact } from "./workspacePresentation";
import { WritingContextPanel } from "./WritingContextPanel";
import { WritingSectionsPanel } from "./WritingSectionsPanel";
import { TablePaginationPanel } from "./TablePaginationPanel";
import { DocumentConsistencyPanel } from "./DocumentConsistencyPanel";
import { canApplySavedWritingToField } from "./writingFieldApplication";
import { StudioSaveIndicator } from "./StudioSaveIndicator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { workspaceReadiness } from "./workspaceReadiness";
import { withCompanyContext } from "@/lib/navigation/companyContext";

const EMPTY_MATERIALIZED_ANSWERS: Record<string, string> = {};
const EMPTY_RHWP_ANCHORS: readonly RhwpFieldAnchor[] = [];
// 구형 quick/studio 완료 상태는 통합 RHWP 작업공간의 렌더 계약에 포함하지 않는다.

/**
 * 같은 source의 server refresh는 진행 중 작업을 취소하지 않고 최신 callback만 교체한다.
 * 실제 source 전환이나 unmount만 현재 비동기 결과를 폐기한다.
 */
export function useSourceScopedAsyncRun(input: {
  sourceKey: string | null;
  runKey: string | null;
  run: (isCurrent: () => boolean) => Promise<void>;
}): void {
  const runRef = useRef(input.run);
  useEffect(() => {
    runRef.current = input.run;
  }, [input.run]);

  useEffect(() => {
    if (!input.runKey || input.runKey !== input.sourceKey) return;
    let disposed = false;
    const startTimer = setTimeout(() => {
      if (disposed) return;
      void runRef.current(() => !disposed);
    }, 0);
    return () => {
      disposed = true;
      clearTimeout(startTimer);
    };
  }, [input.runKey, input.sourceKey]);
}

export function WorkspaceView({
  data,
  greeting,
  institutionContact,
  companyId = null,
}: {
  data: WorkspaceData;
  greeting: ChatMessageContent;
  institutionContact: InstitutionContact | null;
  companyId?: string | null;
}) {
  // Workspace 내부 API(page image/chat/conversion)는 grants.id UUID 계약이다. 공개 route param을
  // 다시 전달하면 bizinfo%3A... 같은 source key가 UUID 전용 API로 흘러가므로 서버 로더의 id만 쓴다.
  const grantId = data.grant.id;
  const readiness = workspaceReadiness(data);
  const virtualPreview = data.execution.mode === "virtual_preview" ? data.execution : null;
  const adminPreview = data.execution.mode === "admin_preview" ? data.execution : null;
  const readOnlyPreview = virtualPreview ?? adminPreview;
  const router = useRouter();
  const [answers, setAnswers] = useState<DraftFieldAnswers>(data.fieldAnswers);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [suggestingLabels, setSuggestingLabels] = useState<Set<string>>(() => new Set());
  const [showChat, setShowChat] = useState(false);
  const [chatScope, setChatScope] = useState<"general" | "field">("general");
  const [writingContextDirty, setWritingContextDirty] = useState(false);
  const [writingSectionsDirty, setWritingSectionsDirty] = useState(false);
  const [mobileSurface, setMobileSurface] = useState("writing");
  const [tablePaginationBusy, setTablePaginationBusy] = useState(false);
  useEffect(() => {
    if (!writingContextDirty && !writingSectionsDirty && !tablePaginationBusy) return;
    // Next Link의 클라이언트 이동은 beforeunload를 발생시키지 않는다.
    const preserveWriting = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const destination = new URL(anchor.href, location.href);
      if (!["http:", "https:"].includes(destination.protocol)) return;
      if (destination.origin === location.origin && destination.pathname === location.pathname && destination.search === location.search) return;
      event.preventDefault(); event.stopPropagation();
      toast.info(tablePaginationBusy ? "표 배치 변경이 끝난 뒤 이동해 주세요." : "회사 자료·사업 설명과 문안의 변경을 먼저 저장해 주세요.");
    };
    document.addEventListener("click", preserveWriting, true);
    return () => document.removeEventListener("click", preserveWriting, true);
  }, [writingContextDirty, writingSectionsDirty, tablePaginationBusy]);
  useEffect(() => {
    if (!tablePaginationBusy) return;
    const preserveTableChange = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preserveTableChange);
    return () => window.removeEventListener("beforeunload", preserveTableChange);
  }, [tablePaginationBusy]);
  const [workingDocument, setWorkingDocument] = useState<RhwpWorkingDocument | null>(null);
  const [studioDocumentActions, setStudioDocumentActions] = useState<RhwpStudioDocumentActionState>({
    saveState: initialStudioSaveState,
    saving: false,
    downloading: false,
    canSave: false,
    canDownload: false,
  });
  const [studioDocumentActionSourceKey, setStudioDocumentActionSourceKey] = useState<string | null>(null);
  const [automaticProfileRunKey, setAutomaticProfileRunKey] = useState<string | null>(null);
  const [automaticProfileBusy, setAutomaticProfileBusy] = useState(false);
  const [automaticProfileUndoRevisionId, setAutomaticProfileUndoRevisionId] = useState<string | null>(null);
  const [fieldBindingsResolved, setFieldBindingsResolved] = useState(false);
  const [fieldBindingStatuses, setFieldBindingStatuses] = useState<Map<string, "unique" | "missing" | "ambiguous">>(
    () => new Map(),
  );
  const [fieldBindingTargets, setFieldBindingTargets] = useState<Map<string, StudioFieldBindingTargetV1>>(() => new Map());
  const [fieldAgentRuns, setFieldAgentRuns] = useState<Map<string, FieldAgentRunDto>>(() => new Map());
  const studioSurfaceRef = useRef<RhwpStudioSurfaceHandle | null>(null);
  const automaticProfileUndoRef = useRef<{
    sourceKey: string;
    revisionId: string;
    entries: readonly AutomaticProfileAutofillEntry[];
  } | null>(null);
  const fieldIdByTargetRef = useRef<Map<string, string>>(new Map());
  const chat = useGrantChat({ grantId, draftId: data.draftId });
  // General advice has no field target/revision. A separate session prevents a previous
  // field conversation from silently constraining the next general question.
  const generalChat = useGrantChat({ grantId });
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const duplicateSet = useMemo(() => new Set(data.duplicateLabels), [data.duplicateLabels]);
  const suggestableSet = useMemo(() => new Set(data.suggestableLabels), [data.suggestableLabels]);
  const authoringTasks = useMemo(() => buildDocumentAuthoringTasks(data.connectedFields), [data.connectedFields]);
  const taskByFieldId = useMemo(
    () => new Map(authoringTasks.map((task) => [task.fieldId, task])),
    [authoringTasks],
  );
  const quickFields = useMemo(
    () => authoringTasks.filter((task) => task.mode === "quick").map((task) => task.field),
    [authoringTasks],
  );
  const studioTransport = useMemo<RhwpWorkingDocumentTransport | null>(() => {
    if (data.ladder === "c") return null;
    if (data.draftId) return { mode: "persistent", draftId: data.draftId };
    if (!readOnlyPreview || !data.activeDocumentKey) return null;
    const params = new URLSearchParams({ document: data.activeDocumentKey });
    if (virtualPreview) params.set("biz", virtualPreview.bizNo);
    if (adminPreview) params.set("adminPreview", "1");
    return {
      mode: "local_preview",
      sourceKey: `${readOnlyPreview.mode}:${grantId}:${data.activeDocumentKey}`,
      sourceUrl: `/api/web/grants/${encodeURIComponent(grantId)}/virtual-source-file?${params.toString()}`,
    };
  }, [adminPreview, data.activeDocumentKey, data.draftId, data.ladder, grantId, readOnlyPreview, virtualPreview]);
  const currentStudioSourceKey = studioTransport ? sourceKeyForTransport(studioTransport) : null;
  const integratedRhwpWorkspace = studioTransport !== null;
  // 필드 위치 인식은 모델 호출이나 서버 저장 권한과 무관한 RHWP read-only 기능이다.
  // 따라서 로컬 관리자/가상기업 미리보기에서도 선분석된 필드가 있으면 같은 native
  // selection protocol을 구독한다. 실제 제안과 영속 저장은 각 capability가 별도로 막는다.
  const integratedFieldEditor = data.ladder === "a" && studioTransport !== null;

  useEffect(() => {
    answersRef.current = data.fieldAnswers;
    setAnswers(data.fieldAnswers);
    setWorkingDocument(null);
    setStudioDocumentActions({
      saveState: initialStudioSaveState,
      saving: false,
      downloading: false,
      canSave: false,
      canDownload: false,
    });
    setStudioDocumentActionSourceKey(null);
    setAutomaticProfileRunKey(null);
    setAutomaticProfileBusy(false);
    setAutomaticProfileUndoRevisionId(null);
    automaticProfileUndoRef.current = null;
    setFieldBindingsResolved(false);
    setFieldBindingStatuses(new Map());
    setFieldBindingTargets(new Map());
    setFieldAgentRuns(new Map());
  }, [currentStudioSourceKey]);

  const handleStudioDocumentActionsChanged = useCallback((next: RhwpStudioDocumentActionState) => {
    setStudioDocumentActions(next);
    setStudioDocumentActionSourceKey(currentStudioSourceKey);
  }, [currentStudioSourceKey]);

  const saveCurrentDocument = useCallback(() => {
    void studioSurfaceRef.current?.saveCurrent();
  }, []);

  const downloadCurrentDocument = useCallback(() => {
    void studioSurfaceRef.current?.downloadCurrentCopy();
  }, []);

  const inspectProfileAutofillBindings = useCallback(() => {
    const surface = studioSurfaceRef.current;
    if (!surface) return Promise.reject(new Error("문서 편집 화면이 준비되지 않았습니다."));
    return surface.inspectProfileAutofill();
  }, []);

  const applyProfileAutofillEntries = useCallback((entries: readonly { fieldId: string; value: string }[]) => {
    const surface = studioSurfaceRef.current;
    if (!surface) return Promise.reject(new Error("문서 편집 화면이 준비되지 않았습니다."));
    return surface.applyProfileAutofill(entries);
  }, []);

  const inspectWritingField = useCallback(async (fieldId: string, savedText: string) => {
    const surface = studioSurfaceRef.current;
    if (!surface) throw new Error("문서 편집 화면이 준비되지 않았습니다.");
    const bindings = await surface.inspectProfileAutofill();
    const binding = bindings.find(item => item.fieldId === fieldId);
    const field = data.connectedFields.find(item => item.fieldId === fieldId);
    return canApplySavedWritingToField(binding, field?.sourceSpan, savedText) && binding && typeof binding.beforeText === "string"
      ? { beforeText: binding.beforeText } : null;
  }, [data.connectedFields]);

  const applyWritingText = useCallback(async (fieldId: string, text: string) => {
    const surface = studioSurfaceRef.current;
    if (!surface) throw new Error("문서 편집 화면이 준비되지 않았습니다.");
    if (!text.trim() || text.length > 4_000) throw new Error("이 문안은 자동 반영 범위를 넘어요. 복사해 양식에서 직접 작성해 주세요.");
    await surface.applyProfileAutofill([{ fieldId, value: text }]);
    await surface.focusField(fieldId);
  }, []);

  const undoAutomaticProfileAutofill = useCallback(async () => {
    const pending = automaticProfileUndoRef.current;
    const surface = studioSurfaceRef.current;
    if (!pending || !surface || pending.sourceKey !== currentStudioSourceKey) return;
    setAutomaticProfileBusy(true);
    try {
      const result = await surface.undoAutomaticProfileAutofill();
      if (result.appliedRevisionId !== pending.revisionId) {
        throw new Error("되돌릴 회사 정보 자동 입력 revision이 바뀌었습니다.");
      }
      const nextAnswers = undoAutomaticProfileAutofillAnswers({
        current: answersRef.current,
        entries: pending.entries,
        appliedRevisionId: pending.revisionId,
      });
      answersRef.current = nextAnswers;
      setAnswers(nextAnswers);
      automaticProfileUndoRef.current = null;
      setAutomaticProfileUndoRevisionId(null);
      toast.success("회사 정보 자동 입력을 되돌리고 선택을 기억했습니다.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "회사 정보 자동 입력을 되돌리지 못했습니다.");
    } finally {
      setAutomaticProfileBusy(false);
    }
  }, [currentStudioSourceKey]);

  const inspectScheduleTable = useCallback(() => {
    const surface = studioSurfaceRef.current;
    if (!surface) return Promise.reject(new Error("문서 편집 화면이 준비되지 않았습니다."));
    return surface.inspectScheduleTable();
  }, []);

  const applyScheduleTable = useCallback((target: ScheduleTableTarget, plan: ScheduleTablePlan) => {
    const surface = studioSurfaceRef.current;
    if (!surface) return Promise.reject(new Error("문서 편집 화면이 준비되지 않았습니다."));
    return surface.applyScheduleTable(target, plan);
  }, []);

  const undoScheduleTable = useCallback(() => {
    const surface = studioSurfaceRef.current;
    if (!surface) return Promise.reject(new Error("문서 편집 화면이 준비되지 않았습니다."));
    return surface.undoScheduleTable();
  }, []);

  const canUndoScheduleTable = useCallback(() => (
    studioSurfaceRef.current?.canUndoScheduleTable() ?? false
  ), []);

  useEffect(() => {
    if (!integratedFieldEditor || !data.fieldEditorAgentAvailable || !data.draftId) return;
    let disposed = false;
    void fetchFieldAgentRuns(data.draftId)
      .then((runs) => {
        if (disposed) return;
        const latestByField = new Map<string, FieldAgentRunDto>();
        // API는 최신 run부터 반환한다. 같은 필드의 오래된 이력은 현재 레일 상태를 덮지 않는다.
        for (const run of runs) {
          if (!latestByField.has(run.fieldId)) latestByField.set(run.fieldId, run);
        }
        setFieldAgentRuns(latestByField);
      })
      .catch(() => {
        // 문서 편집 자체는 제안 이력 조회 실패와 독립적으로 계속 사용할 수 있다.
      });
    return () => {
      disposed = true;
    };
  }, [data.draftId, data.fieldEditorAgentAvailable, integratedFieldEditor]);

  useEffect(() => {
    if (selectedFieldId || data.connectedFields.length === 0) return;
    const first = authoringTasks[0];
    if (first) setSelectedFieldId(first.fieldId);
  }, [selectedFieldId, authoringTasks, data.connectedFields.length]);

  useEffect(() => {
    if (
      data.execution.mode !== "persistent"
      || !integratedFieldEditor
      || !data.draftId
      || !currentStudioSourceKey
      || studioDocumentActionSourceKey !== currentStudioSourceKey
      || !studioDocumentActions.canSave
      || !fieldBindingsResolved
    ) return;
    setAutomaticProfileRunKey((current) => current ?? currentStudioSourceKey);
  }, [
    currentStudioSourceKey,
    data.draftId,
    data.execution.mode,
    fieldBindingsResolved,
    integratedFieldEditor,
    studioDocumentActionSourceKey,
    studioDocumentActions.canSave,
  ]);

  useSourceScopedAsyncRun({
    sourceKey: currentStudioSourceKey,
    runKey: data.draftId ? automaticProfileRunKey : null,
    run: async (isCurrent) => {
      if (!isCurrent()) return;
      setAutomaticProfileBusy(true);
      try {
        const bindings = await inspectProfileAutofillBindings();
        if (!isCurrent()) return;
        const entries = buildAutomaticProfileAutofillEntries({
          fields: data.connectedFields,
          answers: answersRef.current,
          bindings,
          duplicateLabels: duplicateSet,
        });
        if (entries.length === 0) return;
        const surface = studioSurfaceRef.current;
        if (!surface || !currentStudioSourceKey) return;
        const result = await surface.applyProfileAutofill(entries, { automatic: true });
        if (!isCurrent() || !result.revisionId) return;
        const nextAnswers = acceptAutomaticProfileAutofillAnswers({
          current: answersRef.current,
          entries,
          revisionId: result.revisionId,
        });
        answersRef.current = nextAnswers;
        setAnswers(nextAnswers);
        automaticProfileUndoRef.current = {
          sourceKey: currentStudioSourceKey,
          revisionId: result.revisionId,
          entries,
        };
        setAutomaticProfileUndoRevisionId(result.revisionId);
        toast.success(`저장된 회사 정보로 빈 칸 ${result.appliedCount}개를 채웠습니다.`, {
          action: {
            label: "되돌리기",
            onClick: () => void undoAutomaticProfileAutofill(),
          },
        });
      } catch (caught) {
        if (isCurrent()) {
          toast.error(caught instanceof Error ? caught.message : "저장된 회사 정보를 문서에 입력하지 못했습니다.");
        }
      } finally {
        if (isCurrent()) {
          setAutomaticProfileBusy(false);
        }
      }
    },
  });

  const rhwpFields = useMemo<RhwpFieldDescriptor[]>(
    () => data.connectedFields.map((field) => ({
      fieldId: field.fieldId,
      fieldKey: field.fieldKey,
      label: field.label,
      anchorLabel: field.anchorLabel ?? null,
      fieldType: field.fieldType,
      sourceSpan: field.sourceSpan,
      position: field.position,
      options: extractFieldOptions(field.fieldType, field.sourceSpan),
    })),
    [data.connectedFields],
  );

  const fieldAgentSession = useMemo(() => buildFieldAwareDocumentSession({
    tasks: authoringTasks,
    answers,
    selectedFieldId,
    bindingStatuses: fieldBindingStatuses,
    bindingTargets: fieldBindingTargets,
    bindingsResolved: fieldBindingsResolved,
    fieldEditorAgentAvailable: data.fieldEditorAgentAvailable,
    suggestableLabels: suggestableSet,
    suggestingLabels,
  }), [
    answers,
    authoringTasks,
    data.fieldEditorAgentAvailable,
    fieldBindingStatuses,
    fieldBindingTargets,
    fieldBindingsResolved,
    selectedFieldId,
    suggestableSet,
    suggestingLabels,
  ]);

  async function requestSuggestion(field: ConnectedDocumentField, sourceText: string) {
    if (!integratedFieldEditor || !data.draftId) return;
    const normalizedSourceText = sourceText.trim();
    const key = answerKey(field.label);
    setSuggestingLabels((current) => new Set(current).add(key));
    try {
      const run = await studioSurfaceRef.current?.requestFieldSuggestion(
        field.fieldId,
        normalizedSourceText || undefined,
      );
      if (!run) throw new Error("문서 편집기가 아직 준비되지 않았습니다.");
      setFieldAgentRuns((current) => new Map(current).set(field.fieldId, run));
      const suggestion = run.suggestions.find((entry) => entry.status === "pending");
      if (suggestion) {
        setAnswers((current) => ({
          ...current,
          [key]: {
            value: suggestion.value,
            status: "suggested",
            source: "llm",
            suggestedValue: suggestion.value,
            basis: suggestion.rationale,
            fieldId: field.fieldId,
            ...(normalizedSourceText ? { suggestionInput: normalizedSourceText } : {}),
            updatedAt: new Date().toISOString(),
          },
        }));
      } else if (run.status === "empty") {
        toast.info("확인 가능한 근거로 이 필드의 값을 제안하지 못했습니다.");
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "AI 필드 제안을 만들지 못했습니다.");
    } finally {
      setSuggestingLabels((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function runFieldAgentAction(
    action: "apply" | "undo" | "dismiss",
    run: FieldAgentRunDto,
    suggestion: FieldAgentSuggestionDto,
  ) {
    const key = answerKey(run.fieldLabel);
    setSuggestingLabels((current) => new Set(current).add(key));
    try {
      const surface = studioSurfaceRef.current;
      if (!surface) throw new Error("문서 편집기가 아직 준비되지 않았습니다.");
      const updated = action === "apply"
        ? await surface.applyFieldSuggestion(run, suggestion)
        : action === "undo"
          ? await surface.undoFieldSuggestion(run, suggestion)
          : await surface.dismissFieldSuggestion(run, suggestion);
      setFieldAgentRuns((current) => new Map(current).set(run.fieldId, updated));
      if (action === "apply") {
        const applied = updated.suggestions.find((entry) => entry.id === suggestion.id);
        const nextAnswers: DraftFieldAnswers = {
          ...answersRef.current,
          [key]: {
            value: suggestion.value,
            status: "accepted",
            source: "llm",
            suggestedValue: suggestion.value,
            basis: suggestion.rationale,
            fieldId: run.fieldId,
            ...(applied?.appliedRevisionId ? { materializedRevisionId: applied.appliedRevisionId } : {}),
            updatedAt: new Date().toISOString(),
          },
        };
        setAnswers(nextAnswers);
        answersRef.current = nextAnswers;
        // 적용 직후에는 방금 쓴 값과 커서를 그대로 보여 준다. 다음 필드 이동은 사용자가
        // 레일 하단의 "다음 미완료"를 눌렀을 때만 수행한다.
      } else {
        const nextAnswers = { ...answersRef.current };
        if (run.beforeAnswer) nextAnswers[key] = run.beforeAnswer;
        else delete nextAnswers[key];
        setAnswers(nextAnswers);
        answersRef.current = nextAnswers;
      }
    } catch (caught) {
      if (data.draftId) {
        try {
          const refreshedRuns = await fetchFieldAgentRuns(data.draftId);
          const refreshed = refreshedRuns.find((entry) => entry.fieldId === run.fieldId);
          if (refreshed) {
            setFieldAgentRuns((current) => new Map(current).set(run.fieldId, refreshed));
          }
        } catch {
          // 적용 실패 안내가 제안 이력 재조회 실패에 가려지지 않게 한다.
        }
      }
      toast.error(caught instanceof Error ? caught.message : "AI 필드 작업을 완료하지 못했습니다.");
    } finally {
      setSuggestingLabels((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleAskField(field: ConnectedDocumentField) {
    if (readOnlyPreview) {
      toast.info("읽기 전용 시뮬레이션에서는 AI 질문을 실행하지 않습니다.");
      return;
    }
    if (chat.isBusy) {
      toast.info("현재 답변이 끝난 뒤 새 필드 대화를 시작해 주세요.");
      return;
    }
    setSelectedFieldId(field.fieldId);
    setChatScope("field");
    setShowChat(true);
    try {
      const fieldAgent = integratedFieldEditor
        ? await studioSurfaceRef.current?.prepareFieldWritingSession(field.fieldId)
        : null;
      if (integratedFieldEditor && !fieldAgent) {
        throw new Error("문서 편집기가 아직 준비되지 않았습니다.");
      }
      chat.askField({
        label: field.label,
        section: field.section,
        fieldId: field.fieldId,
        ...(fieldAgent ? {
          fieldAgent: {
            baseRevisionId: fieldAgent.baseRevisionId,
            target: fieldAgent.target,
          },
        } : {}),
      });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "필드 대화를 시작하지 못했습니다.");
    }
  }

  function handleSelectField(fieldId: string) {
    setSelectedFieldId(fieldId);
    if (integratedFieldEditor) void studioSurfaceRef.current?.focusField(fieldId);
  }

  function handleStudioSaved(
    document: RhwpWorkingDocument,
    _fieldId: string | null,
    _returnToQuick: boolean,
  ) {
    setWorkingDocument(document);
  }

  const canUndoAutomaticProfileAutofill = Boolean(
    automaticProfileUndoRevisionId
    && workingDocument?.revisionId === automaticProfileUndoRevisionId
    && automaticProfileUndoRef.current?.sourceKey === currentStudioSourceKey
    && studioSurfaceRef.current?.canUndoAutomaticProfileAutofill()
  );

  const handleFieldBindingsResolved = useCallback((resolutions: readonly StudioFieldBindingResolution[]) => {
    setFieldBindingStatuses(new Map(resolutions.map((resolution) => [resolution.fieldId, resolution.status])));
    setFieldBindingTargets(new Map(resolutions.flatMap((resolution) => (
      resolution.status === "unique" ? [[resolution.fieldId, resolution.target] as const] : []
    ))));
    fieldIdByTargetRef.current = new Map(resolutions.flatMap((resolution) => {
      if (resolution.status !== "unique") return [];
      return [[fieldSelectionTargetKey(resolution.target), resolution.fieldId]];
    }));
    setFieldBindingsResolved(true);
  }, []);

  const handleStudioFieldSelection = useCallback((target: StudioFieldTargetV1 | StudioBodyParagraphTargetV1 | null) => {
    if (!target) return;
    const fieldId = fieldIdByTargetRef.current.get(fieldSelectionTargetKey(target));
    if (!fieldId) return;
    setSelectedFieldId(fieldId);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <Link
            href={virtualPreview
              ? `/grants/${encodeURIComponent(grantId)}?biz=${encodeURIComponent(virtualPreview.bizNo)}`
              : adminPreview
                ? `/grants/${encodeURIComponent(grantId)}?adminPreview=1`
                : companyId ? withCompanyContext(`/grants/${encodeURIComponent(grantId)}`, companyId) : `/grants/${encodeURIComponent(grantId)}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            공고 요약
          </Link>
          <h1 className="truncate text-base font-semibold sm:text-lg">{data.grant.title}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {integratedRhwpWorkspace && !readOnlyPreview ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-general-grant-chat
              onClick={() => {
                setChatScope("general");
                setShowChat(true);
              }}
            >
              <MessageSquare data-icon="inline-start" aria-hidden />
              AI 상담
            </Button>
          ) : null}
          {integratedRhwpWorkspace ? <div className="flex flex-col items-end gap-2" data-workspace-file-actions>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!studioDocumentActions.canSave} onClick={saveCurrentDocument}>{studioDocumentActions.saving ? "파일 저장 중…" : readOnlyPreview ? "이 탭에 반영" : "양식 파일 저장"}</Button>
              <Button size="sm" variant="outline" disabled={!studioDocumentActions.canDownload} onClick={downloadCurrentDocument}>{studioDocumentActions.downloading ? "내보내는 중…" : "편집본 다운로드"}</Button>
            </div>
            <StudioSaveIndicator state={studioDocumentActions.saveState} />
          </div> : null}
          {!integratedRhwpWorkspace && !readOnlyPreview && data.draftId ? <WritingContextPanel key={data.draftId} draftId={data.draftId} onDirtyChange={setWritingContextDirty} /> : null}
          {!integratedRhwpWorkspace && !readOnlyPreview && data.draftId ? <WritingSectionsPanel key={data.draftId} draftId={data.draftId} onDirtyChange={setWritingSectionsDirty} /> : null}
          {!readOnlyPreview && integratedFieldEditor && data.draftId ? <TablePaginationPanel key={currentStudioSourceKey} getSurface={() => studioSurfaceRef.current} onBusyChange={setTablePaginationBusy} /> : null}
          {!readOnlyPreview && integratedFieldEditor && data.draftId ? <DocumentConsistencyPanel key={`check:${currentStudioSourceKey}`} draftId={data.draftId} getSurface={() => studioSurfaceRef.current} disabled={writingContextDirty || tablePaginationBusy} /> : null}
          {canUndoAutomaticProfileAutofill ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={automaticProfileBusy}
              onClick={() => void undoAutomaticProfileAutofill()}
            >
              <RotateCcw data-icon="inline-start" aria-hidden />
              회사 정보 입력 되돌리기
            </Button>
          ) : null}
          {data.documents.length > 1 && data.activeDocumentKey ? (
            <Select
              value={data.activeDocumentKey}
              disabled={suggestingLabels.size > 0 || automaticProfileBusy || writingContextDirty || writingSectionsDirty || tablePaginationBusy}
              // Base UI Select 는 items 를 줘야 SelectValue 가 raw value(documentKey) 대신 label 을 렌더한다.
              items={data.documents.map((document) => ({ value: document.documentKey, label: document.label }))}
              onValueChange={(next) => {
                if (next && next !== data.activeDocumentKey) {
                  const params = new URLSearchParams({ document: next });
                  if (companyId) params.set("companyId", companyId);
                  if (virtualPreview) params.set("biz", virtualPreview.bizNo);
                  if (adminPreview) params.set("adminPreview", "1");
                  router.push(`/grants/${encodeURIComponent(grantId)}/workspace?${params.toString()}`);
                }
              }}
            >
              <SelectTrigger aria-label="작성할 서류 선택" className="min-w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {data.documents.map((document) => (
                    <SelectItem key={document.documentKey} value={document.documentKey}>
                      {document.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      {readOnlyPreview ? (
        <div className="border-b border-brand/20 bg-surface-brand px-4 py-2.5 text-sm text-text-nav sm:px-6" role="status">
          <strong className="text-brand">{adminPreview ? "관리자 RHWP 작성 시뮬레이션" : "가상 기업 RHWP 작성 미리보기"}</strong>
          <span className="ml-2">
            {readOnlyPreview.companyName} 기준으로 열었어요. 자동으로 연결 가능한 기업정보만 제안되며, 이 탭에서 바꾼 값은 새로고침하면 초기화되고 실제 회사·초안에는 저장되지 않습니다.
          </span>
        </div>
      ) : null}

      <details className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground sm:px-6">
        <summary className="cursor-pointer">작성 기능·저장 상태 안내</summary>
        <p className="mt-2">{readiness.editing} · {readiness.suggestions}</p>
        <p className="mt-1">{readiness.saving}</p>
        <p className="mt-1">{readiness.finalReview}</p>
      </details>

      {integratedRhwpWorkspace && readiness.fieldAnalysisNotice ? (
        <div className="shrink-0 px-3 pt-3 xl:px-4">
          <Alert role="status">
            <AlertTitle>{readiness.fieldAnalysisNotice.title}</AlertTitle>
            <AlertDescription>{readiness.fieldAnalysisNotice.description}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {integratedRhwpWorkspace ? <Tabs value={mobileSurface} onValueChange={setMobileSurface} className="shrink-0 px-3 pt-3 xl:hidden">
        <TabsList className="grid w-full grid-cols-2" aria-label="작성 화면 전환"><TabsTrigger value="writing">문항 작성</TabsTrigger><TabsTrigger value="document">원본 양식</TabsTrigger></TabsList>
      </Tabs> : null}

      {integratedFieldEditor && studioTransport ? (
        <>
          <div
            data-field-aware-editor
            className="grid min-h-0 flex-1 gap-4 overflow-auto p-3 xl:grid-cols-[minmax(0,1fr)_400px] xl:overflow-hidden xl:p-4"
          >
            <div className={cn("min-h-[72dvh] min-w-0 xl:flex xl:min-h-0", mobileSurface === "document" ? "flex" : "hidden")}>
              <RhwpStudioSurface
                key={currentStudioSourceKey}
                ref={studioSurfaceRef}
                transport={studioTransport}
                answers={answers}
                quickFields={quickFields}
                connectedFields={rhwpFields}
                manualAnchors={EMPTY_RHWP_ANCHORS}
                duplicateLabels={duplicateSet}
                workingDocument={workingDocument}
                headMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
                activeTask={taskByFieldId.get(selectedFieldId ?? "") ?? null}
                documentAgentAvailable={false}
                fieldEditorAgentAvailable={data.fieldEditorAgentAvailable}
                presentation="field_aware"
                onDocumentActionStateChanged={handleStudioDocumentActionsChanged}
                onFieldBindingsResolved={handleFieldBindingsResolved}
                onFieldSelectionChanged={handleStudioFieldSelection}
                onSaved={handleStudioSaved}
              />
            </div>
            <div className={cn("min-h-0 min-w-0 xl:block xl:overflow-y-auto", mobileSurface === "writing" ? "block" : "hidden")}>
              {!readOnlyPreview && data.draftId ? <WritingSectionsPanel key={data.draftId} draftId={data.draftId} presentation="inline" onDirtyChange={setWritingSectionsDirty} selectedFieldId={selectedFieldId} onSelectField={handleSelectField} inspectField={inspectWritingField} applySavedText={applyWritingText} contextActions={<WritingContextPanel key={data.draftId} draftId={data.draftId} onDirtyChange={setWritingContextDirty} />} /> : null}
              <details className="mt-4"><summary className="cursor-pointer py-2 text-sm font-medium">입력 위치·작성 도우미</summary><div className="h-[650px] min-h-0">
              <FieldAgentRail
                session={fieldAgentSession}
                connectedFields={data.connectedFields}
                {...(readOnlyPreview ? {
                  assistDisabledMessage: "읽기 전용 시뮬레이션에서는 LLM 제안을 실행하지 않습니다. 필드 위치 확인과 직접 편집은 가능합니다.",
                } : {})}
                run={selectedFieldId ? fieldAgentRuns.get(selectedFieldId) ?? null : null}
                onSelectField={handleSelectField}
                onRequestSuggestion={requestSuggestion}
                onStartConversation={(field) => void handleAskField(field)}
                onApplySuggestion={(run, suggestion) => void runFieldAgentAction("apply", run, suggestion)}
                onUndoSuggestion={(run, suggestion) => void runFieldAgentAction("undo", run, suggestion)}
                onDismissSuggestion={(run, suggestion) => void runFieldAgentAction("dismiss", run, suggestion)}
                documentActions={{
                  ...studioDocumentActions,
                  saveLabel: readOnlyPreview ? "이 탭에 반영" : "지금 저장",
                  onSave: saveCurrentDocument,
                  onDownload: downloadCurrentDocument,
                }}
                profileAutofill={data.draftId ? {
                  draftId: data.draftId,
                  disabled: !studioDocumentActions.canSave,
                  inspectBindings: inspectProfileAutofillBindings,
                  applyEntries: applyProfileAutofillEntries,
                } : undefined}
                scheduleTable={data.draftId && data.fieldEditorAgentAvailable ? {
                  draftId: data.draftId,
                  disabled: !studioDocumentActions.canSave,
                  inspectTable: inspectScheduleTable,
                  applyPlan: applyScheduleTable,
                  undoLatest: undoScheduleTable,
                  canUndoLatest: canUndoScheduleTable,
                } : undefined}
              />
              </div></details>
            </div>
          </div>
        </>
      ) : null}

      {integratedRhwpWorkspace && !integratedFieldEditor && studioTransport ? (
        <div data-document-guided-editor className="grid min-h-0 flex-1 gap-4 overflow-auto p-3 xl:grid-cols-[minmax(0,1fr)_400px] xl:p-4">
          <div className={cn("min-h-[72dvh] min-w-0 xl:flex xl:min-h-0", mobileSurface === "document" ? "flex" : "hidden")}>
          <RhwpStudioSurface
            key={currentStudioSourceKey}
            ref={studioSurfaceRef}
            transport={studioTransport}
            answers={answers}
            quickFields={quickFields}
            connectedFields={rhwpFields}
            manualAnchors={EMPTY_RHWP_ANCHORS}
            duplicateLabels={duplicateSet}
            workingDocument={workingDocument}
            headMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
            activeTask={null}
            documentAgentAvailable={data.documentAgentAvailable}
            presentation="document_guided"
            onDocumentActionStateChanged={handleStudioDocumentActionsChanged}
            onSaved={handleStudioSaved}
          />
          </div>
          <div className={cn("min-w-0 xl:block", mobileSurface === "writing" ? "block" : "hidden")}>
            {!readOnlyPreview && data.draftId ? <WritingSectionsPanel key={data.draftId} draftId={data.draftId} presentation="inline" onDirtyChange={setWritingSectionsDirty} contextActions={<WritingContextPanel key={data.draftId} draftId={data.draftId} onDirtyChange={setWritingContextDirty} />} /> : <Alert><AlertDescription>원본 양식에서 직접 작성할 수 있어요. 저장과 내보내기는 상단에서 확인해 주세요.</AlertDescription></Alert>}
          </div>
        </div>
      ) : null}

      {!integratedRhwpWorkspace ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
            {data.honestNotice ? (
              <Alert>
                <AlertTitle>문서 작성 안내</AlertTitle>
                <AlertDescription>{data.honestNotice}</AlertDescription>
              </Alert>
            ) : null}
            {data.ladder !== "c" ? (
              <Alert>
                <AlertTitle>RHWP 문서를 준비하지 못했습니다.</AlertTitle>
                <AlertDescription>
                  원본 문서와 초안 연결을 다시 확인한 뒤 새로고침해 주세요. 별도의 보조 입력 화면으로 전환하지 않습니다.
                </AlertDescription>
              </Alert>
            ) : readOnlyPreview ? (
              <Alert>
                <AlertTitle>읽기 전용 시뮬레이션</AlertTitle>
                <AlertDescription>
                  이 공고는 RHWP 편집을 지원하지 않아 저장이나 AI 작성을 실행하지 않습니다.
                </AlertDescription>
              </Alert>
            ) : (
              <ChatPanelView
                controller={chat}
                greeting={greeting}
                variant="front"
                institutionContact={institutionContact}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* 1:1 채팅 Dialog 오버레이(§2-④) — 닫으면 확인 루프가 그 자리에 그대로 있다. */}
      {integratedRhwpWorkspace && !readOnlyPreview ? (
        <Dialog open={showChat} onOpenChange={setShowChat}>
          <DialogContent className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-4 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-7xl sm:p-5">
            <DialogTitle className="sr-only">이 공고에 대해 물어보기</DialogTitle>
            <DialogDescription className="sr-only">
              공고 내용·자격·마감·작성 요령을 채팅으로 물어볼 수 있어요.
            </DialogDescription>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-7 sm:pt-3">
              <ChatPanelView
                controller={chatScope === "general" ? generalChat : chat}
                greeting={greeting}
                variant="front"
                fillAvailableHeight
                institutionContact={institutionContact}
                onApplyFieldProposal={({ fieldId, value, runId, suggestionId }) => {
                  if (chatScope !== "field" || !integratedFieldEditor) {
                    toast.info("일반 상담의 문안은 검토 후 원본 양식에서 직접 작성해 주세요.");
                    return;
                  }
                  if (!data.draftId || !runId || !suggestionId) {
                    toast.error("현재 문서 revision에 결속된 제안이 아닙니다. 필드 대화를 다시 시작해 주세요.");
                    return;
                  }
                  void fetchFieldAgentRuns(data.draftId)
                    .then((runs) => {
                      const run = runs.find((entry) => entry.id === runId && entry.fieldId === fieldId);
                      const suggestion = run?.suggestions.find((entry) => entry.id === suggestionId);
                      if (!run || !suggestion || suggestion.value !== value) {
                        throw new Error("대화에서 만든 제안을 현재 문서 revision에서 찾지 못했습니다.");
                      }
                      setFieldAgentRuns((current) => new Map(current).set(run.fieldId, run));
                      setShowChat(false);
                      return runFieldAgentAction("apply", run, suggestion);
                    })
                    .catch((caught) => {
                      toast.error(caught instanceof Error ? caught.message : "대화 제안을 문서에 반영하지 못했습니다.");
                    });
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {data.pollConversion && !readOnlyPreview ? <ConversionPollTrigger key={grantId} grantId={grantId} /> : null}
    </div>
  );
}
