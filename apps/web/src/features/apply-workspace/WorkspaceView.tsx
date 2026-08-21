"use client";

/**
 * 작성 도우미 workspace 오케스트레이터 (Apply Experience v2 · 재정의 2026-07-15).
 *
 * 이 화면이 답하는 질문은 단 하나 — "이 칸에 이 값을 넣어도 되나요?". 조종석에 보이는 것은
 * 미리보기 + 확인 카드 1장 + 진행 표시 3가지뿐이다(재정의 §0). 사다리·ladder·draft 등 내부
 * 어휘는 화면에 노출하지 않는다.
 *
 * 상단 바(재정의 §2-①): ← 공고 요약 / 공고명 / M/N 확인 완료(단일 축) / 하나씩·전체 목록 토글 /
 *   문서 Select(2개 이상일 때만). 채팅은 패널 대체가 아니라 Dialog 오버레이(§2-④) — 닫으면 루프가
 *   그 자리에 그대로 있다. 하단 상시 바는 제거(§2-⑤).
 *
 * 사다리(서버 개념, 화면 비노출):
 *  (a) 프리뷰+오버레이+확인 카드
 *  (b) 프리뷰 + "작성 항목 분석 중" + missingFields 질문 카드
 *  (c) 정직 고지 + 채팅 전면(기관 연락처 포함) — 확인 루프 불성립(§2-⑥, DraftFallbackEditor 미렌더)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, FilePenLine, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { parsePositionBbox, parsePositionPage } from "@/lib/documents/bbox";
import { extractFieldOptions } from "@/lib/documents/fieldOptions";
import type {
  RhwpFieldAnchor,
  RhwpFieldDescriptor,
} from "@/lib/rhwp/fieldAnchors";
import {
  sourceKeyForTransport,
  type RhwpWorkingDocument,
  type RhwpWorkingDocumentTransport,
} from "@/lib/rhwp/workingDocument";
import type { DraftFieldAnswers, DraftFieldAnswerStatus } from "@/lib/server/documents/fieldAnswers";
import type { FieldAgentRunDto, FieldAgentSuggestionDto } from "@/lib/server/documents/fieldAgentRuns";
import { fetchFieldAgentRuns } from "@/lib/rhwp/fieldAgentApi";
import type { StudioFieldTargetV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";
import type { StudioFieldBindingResolution } from "@/lib/rhwp/studioFieldBindings";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { WorkspaceData } from "@/lib/server/documents/workspaceData";
import type { ChatMessageContent } from "@/lib/chat/messageContent";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { PreviewCanvas, type PreviewOverlayField } from "@/features/document-viewer/PreviewCanvas";
import { ApplicationFieldAnalysisTrigger } from "./ApplicationFieldAnalysisTrigger";
import { answerKey, fieldVisualState, optimisticApply } from "./fieldAnswerState";
import { ChatPanelView, useGrantChat } from "./ChatPanel";
import {
  buildDocumentAuthoringTasks,
  computeAuthoringProgress,
  isAuthoringTaskComplete,
  nextIncompleteTask,
  type DocumentAuthoringMode,
  type StudioTaskStates,
  type StudioTaskStatus,
} from "./documentAuthoring";
import { FieldPanel, type WorkspacePanelMode } from "./FieldPanel";
import { FieldAgentRail } from "./FieldAgentRail";
import { buildFieldAwareDocumentSession, fieldSelectionTargetKey } from "./fieldAwareDocumentSession";
import { RhwpStudioSurface, type RhwpStudioSurfaceHandle } from "./RhwpStudioSurface";
import { workspaceFieldState, type InstitutionContact } from "./workspacePresentation";

const EMPTY_MATERIALIZED_ANSWERS: Record<string, string> = {};

export function WorkspaceView({
  data,
  greeting,
  institutionContact,
}: {
  data: WorkspaceData;
  greeting: ChatMessageContent;
  institutionContact: InstitutionContact | null;
}) {
  // Workspace 내부 API(page image/chat/conversion)는 grants.id UUID 계약이다. 공개 route param을
  // 다시 전달하면 bizinfo%3A... 같은 source key가 UUID 전용 API로 흘러가므로 서버 로더의 id만 쓴다.
  const grantId = data.grant.id;
  const virtualPreview = data.execution.mode === "virtual_preview" ? data.execution : null;
  const adminPreview = data.execution.mode === "admin_preview" ? data.execution : null;
  const readOnlyPreview = virtualPreview ?? adminPreview;
  const router = useRouter();
  const [answers, setAnswers] = useState<DraftFieldAnswers>(data.fieldAnswers);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(() => new Set());
  const [suggestingLabels, setSuggestingLabels] = useState<Set<string>>(() => new Set());
  const [panelMode, setPanelMode] = useState<WorkspacePanelMode>("single");
  const [showChat, setShowChat] = useState(false);
  const [showFieldAgent, setShowFieldAgent] = useState(false);
  const [rhwpAnchorsReady, setRhwpAnchorsReady] = useState(false);
  const [locatingFieldId, setLocatingFieldId] = useState<string | null>(null);
  const [manualAnchors, setManualAnchors] = useState<RhwpFieldAnchor[]>([]);
  const [authoringMode, setAuthoringMode] = useState<Extract<DocumentAuthoringMode, "quick" | "studio">>("quick");
  const [studioSourceKey, setStudioSourceKey] = useState<string | null>(null);
  const [studioTaskStates, setStudioTaskStates] = useState<StudioTaskStates>({});
  const [workingDocument, setWorkingDocument] = useState<RhwpWorkingDocument | null>(null);
  const [workingPreviewUrl, setWorkingPreviewUrl] = useState<string | null>(null);
  const [fieldBindingsResolved, setFieldBindingsResolved] = useState(false);
  const [fieldBindingStatuses, setFieldBindingStatuses] = useState<Map<string, "unique" | "missing" | "ambiguous">>(
    () => new Map(),
  );
  const [fieldBindingTargets, setFieldBindingTargets] = useState<Map<string, StudioFieldTargetV1>>(() => new Map());
  const [fieldAgentRuns, setFieldAgentRuns] = useState<Map<string, FieldAgentRunDto>>(() => new Map());
  const studioSurfaceRef = useRef<RhwpStudioSurfaceHandle | null>(null);
  const fieldIdByTargetRef = useRef<Map<string, string>>(new Map());
  const chat = useGrantChat({ grantId, draftId: data.draftId });
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
  const studioTasks = useMemo(
    () => authoringTasks.filter((task) => task.mode === "studio"),
    [authoringTasks],
  );
  const terminalApplicationPrecompute = data.applicationPrecomputeStatus === "review_required"
    || data.applicationPrecomputeStatus === "not_applicable"
    || data.applicationPrecomputeStatus === "failed";
  const studioTransport = useMemo<RhwpWorkingDocumentTransport | null>(() => {
    if (data.ladder !== "a" && !terminalApplicationPrecompute) return null;
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
  }, [adminPreview, data.activeDocumentKey, data.draftId, data.ladder, grantId, readOnlyPreview, terminalApplicationPrecompute, virtualPreview]);
  const currentStudioSourceKey = studioTransport ? sourceKeyForTransport(studioTransport) : null;
  // Studio는 복합 과제 전용 화면이 아니라 준비된 HWP/HWPX 전체 문서 편집기이기도 하다.
  // 따라서 모든 필드가 quick으로 분류돼도 ladder (a)의 원본 draft에서는 직접 열 수 있어야 한다.
  const canOpenStudio = studioTransport !== null;
  const integratedFieldEditor = data.ladder === "a" && studioTransport?.mode === "persistent";

  useEffect(() => {
    setAuthoringMode("quick");
    setStudioSourceKey(null);
    setStudioTaskStates({});
    setWorkingDocument(null);
    setFieldBindingsResolved(false);
    setFieldBindingStatuses(new Map());
    setFieldBindingTargets(new Map());
    setFieldAgentRuns(new Map());
  }, [currentStudioSourceKey]);

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
    if (!workingDocument) {
      setWorkingPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob(
      [workingDocument.bytes as BlobPart],
      { type: "application/octet-stream" },
    ));
    setWorkingPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [workingDocument]);

  useEffect(() => {
    if (selectedFieldId || data.connectedFields.length === 0) return;
    const first = nextIncompleteTask({ tasks: authoringTasks, answers, studioTaskStates });
    if (first) setSelectedFieldId(first.fieldId);
  }, [selectedFieldId, authoringTasks, answers, studioTaskStates]);

  const materializedAnswers =
    workingDocument?.materializedAnswers ?? data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS;

  const overlayFields = useMemo<PreviewOverlayField[]>(
    () =>
      data.connectedFields.map((field) => {
        const answer = answers[answerKey(field.label)];
        const options = extractFieldOptions(field.fieldType, field.sourceSpan);
        const task = taskByFieldId.get(field.fieldId);
        const studioComplete = task?.mode === "studio"
          && isAuthoringTaskComplete({ task, answers, studioTaskStates });
        return {
          fieldId: field.fieldId,
          label: field.label,
          page: parsePositionPage(field.position),
          box: parsePositionBbox(field.position),
          state: studioComplete ? "confirmed" : fieldVisualState(field.label, answers, duplicateSet),
          // 확정(accepted/edited)된 값만 오버레이 안에 실제 기입처럼 렌더한다(R2).
          value: workspaceFieldState(answer) === "filled" ? answer?.value ?? null : null,
          valueAlreadyInDocument: Boolean(
            answer?.value
            && materializedAnswers[field.fieldId] === answer.value,
          ),
          isChoiceField: options.length > 0,
          visualEvidence: field.visualEvidence,
          authoringMode: task?.mode === "studio" ? "studio" : "quick",
        };
      }),
    [
      data.connectedFields,
      answers,
      duplicateSet,
      materializedAnswers,
      studioTaskStates,
      taskByFieldId,
    ],
  );

  const rhwpFields = useMemo<RhwpFieldDescriptor[]>(
    () => data.connectedFields.map((field) => ({
      fieldId: field.fieldId,
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      sourceSpan: field.sourceSpan,
      position: field.position,
      options: extractFieldOptions(field.fieldType, field.sourceSpan),
    })),
    [data.connectedFields],
  );

  // 진행 표시는 단일 축(confirmed/total). 필수/전체 이중 표기는 폐기(재정의 §2-①).
  const progress = useMemo(() => {
    if (data.ladder !== "a" || data.connectedFields.length === 0) return null;
    return computeAuthoringProgress({ tasks: authoringTasks, answers, studioTaskStates, pendingLabels });
  }, [data.ladder, data.connectedFields.length, authoringTasks, answers, studioTaskStates, pendingLabels]);

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

  async function patchAnswer(label: string, entry: { value?: string; status: DraftFieldAnswerStatus }) {
    const key = answerKey(label);
    const prev = answersRef.current;
    if (readOnlyPreview) {
      const optimistic = optimisticApply(prev, key, entry);
      setAnswers(optimistic);
      answersRef.current = optimistic;
      if (entry.status === "accepted" || entry.status === "edited" || entry.status === "dismissed") {
        const currentTask = authoringTasks.find((task) => answerKey(task.label) === key);
        const next = nextIncompleteTask({
          tasks: authoringTasks,
          ...(currentTask ? { afterFieldId: currentTask.fieldId } : {}),
          answers: optimistic,
          studioTaskStates,
        });
        setSelectedFieldId(next?.fieldId ?? null);
      }
      return;
    }
    if (!data.draftId) return;
    setAnswers(optimisticApply(prev, key, entry));
    setPendingLabels((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    try {
      const response = await fetch(
        `/api/web/document-drafts/${encodeURIComponent(data.draftId)}/field-answers`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: { [key]: entry } }),
        },
      );
      const payload = (await response.json()) as ActionResult<{
        fieldAnswers: DraftFieldAnswers;
        filledFields: Record<string, string>;
      }>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "필드 답변을 저장하지 못했습니다.");
      }
      // 이 응답의 label 항목만 반영한다(전체 맵 교체 금지) — 동시에 다른 필드가 진행 중이면
      // 그 낙관적 업데이트를 이 응답으로 덮어써 클로버할 수 있기 때문(서버는 요청 시점 스냅샷 기준
      // 전체 fieldAnswers 를 돌려주므로, 그 사이 도착한 형제 패치의 결과를 모른다).
      const serverEntry = payload.data.fieldAnswers[key];
      setAnswers((cur) => {
        const next = { ...cur };
        if (serverEntry === undefined) delete next[key];
        else next[key] = serverEntry;
        return next;
      });
      if (entry.status === "accepted" || entry.status === "edited" || entry.status === "dismissed") {
        const optimistic = optimisticApply(prev, key, entry);
        const currentTask = authoringTasks.find((task) => answerKey(task.label) === key);
        const next = nextIncompleteTask({
          tasks: authoringTasks,
          ...(currentTask ? { afterFieldId: currentTask.fieldId } : {}),
          answers: optimistic,
          studioTaskStates,
        });
        setSelectedFieldId(next?.fieldId ?? null);
      }
    } catch (caught) {
      // 실패한 이 필드(key)만 패치 이전 값으로 되돌린다 — 전체 맵 롤백은 그 사이 완료된
      // 다른 필드의 성공 결과까지 되돌려버리는 교차-필드 클로버 버그였다.
      setAnswers((cur) => {
        const next = { ...cur };
        if (prev[key] === undefined) delete next[key];
        else next[key] = prev[key];
        return next;
      });
      toast.error(caught instanceof Error ? caught.message : "필드 답변을 저장하지 못했습니다.");
    } finally {
      setPendingLabels((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function requestSuggestion(field: ConnectedDocumentField, sourceText: string) {
    if (!data.draftId) return;
    const normalizedSourceText = sourceText.trim();
    const key = answerKey(field.label);
    if (integratedFieldEditor) {
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
      return;
    }
    if (!normalizedSourceText) return;
    const existing = answersRef.current[key];
    // 기존 제안을 편집해 다시 보강하는 경우에만 regenerate 로 기록한다.
    const mode: "generate" | "regenerate" = existing?.value ? "regenerate" : "generate";
    setSuggestingLabels((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    try {
      const response = await fetch(
        `/api/web/document-drafts/${encodeURIComponent(data.draftId)}/field-suggestions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            labels: [field.label],
            mode,
            sourceText: normalizedSourceText,
          }),
        },
      );
      const payload = (await response.json()) as ActionResult<{
        suggestions: Record<string, {
          value: string;
          basis: string;
          suggestionInput?: string;
        }>;
      }>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "입력한 내용을 보강하지 못했습니다.");
      }
      // 응답 suggestions 는 이미 서버가 suggested/llm 로 저장한 값이다(저장-반환 일치). 로컬 반영만 한다.
      const suggestion = payload.data.suggestions[field.label] ?? payload.data.suggestions[key];
      if (!suggestion) {
        toast.error("입력한 사실을 유지한 보강안을 만들지 못했습니다. 내용을 조금 더 구체적으로 적어 주세요.");
        return;
      }
      setAnswers((cur) => {
        const prevEntry = cur[key];
        const nextEntry: DraftFieldAnswers[string] = {
          value: suggestion.value,
          status: "suggested",
          source: "llm",
          suggestedValue: suggestion.value,
          suggestionInput: suggestion.suggestionInput ?? normalizedSourceText,
          basis: suggestion.basis,
          updatedAt: new Date().toISOString(),
        };
        if (prevEntry?.fieldId !== undefined) nextEntry.fieldId = prevEntry.fieldId;
        return { ...cur, [key]: nextEntry };
      });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "입력한 내용을 보강하지 못했습니다.");
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
        const next = nextIncompleteTask({
          tasks: authoringTasks,
          afterFieldId: run.fieldId,
          answers: nextAnswers,
          studioTaskStates,
        });
        if (next && next.fieldId !== run.fieldId) handleSelectField(next.fieldId);
      } else {
        const nextAnswers = { ...answersRef.current };
        if (run.beforeAnswer) nextAnswers[key] = run.beforeAnswer;
        else delete nextAnswers[key];
        setAnswers(nextAnswers);
        answersRef.current = nextAnswers;
        if (action === "dismiss"
            && !updated.suggestions.some((entry) => entry.status === "pending")) {
          const next = nextIncompleteTask({
            tasks: authoringTasks,
            afterFieldId: run.fieldId,
            answers: nextAnswers,
            studioTaskStates,
          });
          if (next && next.fieldId !== run.fieldId) handleSelectField(next.fieldId);
        }
      }
    } catch (caught) {
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
    setLocatingFieldId(null);
    setPanelMode("single");
    if (integratedFieldEditor) void studioSurfaceRef.current?.focusField(fieldId);
  }

  function openStudio(fieldId?: string) {
    if (!studioTransport) {
      toast.error("원본 문서가 준비된 뒤 직접 편집할 수 있습니다.");
      return;
    }
    const target = (fieldId ? taskByFieldId.get(fieldId) : null)
      ?? studioTasks.find((task) => task.fieldId === selectedFieldId)
      ?? studioTasks.find((task) => !isAuthoringTaskComplete({ task, answers, studioTaskStates }))
      ?? studioTasks[0];
    if (target) setSelectedFieldId(target.fieldId);
    setStudioSourceKey(sourceKeyForTransport(studioTransport));
    setAuthoringMode("studio");
  }

  function setStudioTaskStatus(fieldId: string, status: StudioTaskStatus) {
    const nextStates = { ...studioTaskStates, [fieldId]: status };
    setStudioTaskStates(nextStates);
    const next = nextIncompleteTask({
      tasks: authoringTasks,
      afterFieldId: fieldId,
      answers,
      studioTaskStates: nextStates,
    });
    if (next) setSelectedFieldId(next.fieldId);
  }

  function handleStudioSaved(
    document: RhwpWorkingDocument,
    fieldId: string | null,
    returnToQuick: boolean,
  ) {
    setWorkingDocument(document);
    if (fieldId) setStudioTaskStates((current) => ({ ...current, [fieldId]: "edited" }));
    if (returnToQuick) setAuthoringMode("quick");
  }

  const handleRhwpAnchorsChange = useCallback((_fieldIds: ReadonlySet<string>) => {
    setRhwpAnchorsReady(true);
  }, []);

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

  const handleStudioFieldSelection = useCallback((target: StudioFieldTargetV1 | null) => {
    if (!target) return;
    const fieldId = fieldIdByTargetRef.current.get(fieldSelectionTargetKey(target));
    if (!fieldId) return;
    setSelectedFieldId(fieldId);
    setLocatingFieldId(null);
    setPanelMode("single");
  }, []);

  const handleLocateField = useCallback((anchor: RhwpFieldAnchor) => {
    setManualAnchors((current) => [...current.filter((entry) => entry.fieldId !== anchor.fieldId), anchor]);
    setLocatingFieldId(null);
    toast.success(`'${anchor.label}' 입력 위치를 현재 문서 셀로 지정했습니다.`);
  }, []);

  const previewCanvas = (
    <PreviewCanvas
      grantId={grantId}
      grantTitle={data.grant.title}
      pages={data.pages}
      overlayFields={overlayFields}
      selectedFieldId={selectedFieldId}
      onSelectField={handleSelectField}
      fill
      rhwpSourceUrl={(workingDocument?.sourceKey === currentStudioSourceKey ? workingPreviewUrl : null) ?? (data.draftId
        ? `/api/web/document-drafts/${encodeURIComponent(data.draftId)}/source-file?revision=head`
        : null)}
      rhwpFields={rhwpFields}
      manualAnchors={manualAnchors}
      locatingFieldId={locatingFieldId}
      onLocateField={handleLocateField}
      onRhwpAnchorsChange={handleRhwpAnchorsChange}
      pageImageAccessBizNo={virtualPreview?.bizNo ?? null}
      pageImageAccessAdminPreview={Boolean(adminPreview)}
    />
  );

  const fieldPanel = (
    <FieldPanel
      ladder={data.ladder}
      applicationPrecomputeStatus={data.applicationPrecomputeStatus}
      grantId={grantId}
      activeDocumentKey={data.activeDocumentKey}
      connectedFields={data.connectedFields}
      answers={answers}
      duplicateLabels={duplicateSet}
      suggestableLabels={suggestableSet}
      fieldLessonTips={data.fieldLessonTips}
      missingFields={data.missingFields}
      selectedFieldId={selectedFieldId}
      pendingLabels={pendingLabels}
      suggestingLabels={suggestingLabels}
      onSelectField={handleSelectField}
      patchAnswer={patchAnswer}
      onAskField={handleAskField}
      onRequestSuggestion={requestSuggestion}
      mode={panelMode}
      draftId={data.draftId}
      hwpxTemplateAvailable={data.hwpxTemplateAvailable}
      rhwpAnchorsReady={rhwpAnchorsReady}
      locatingFieldId={locatingFieldId}
      manualAnchors={manualAnchors}
      onStartLocateField={(fieldId) => {
        setSelectedFieldId(fieldId);
        setLocatingFieldId(fieldId);
      }}
      authoringTasks={authoringTasks}
      studioTaskStates={studioTaskStates}
      onOpenStudio={openStudio}
      onSetStudioTaskStatus={setStudioTaskStatus}
      workingDocument={workingDocument}
      studioServerSaved={Boolean(
        workingDocument
          ? workingDocument.serverSavedAt
          : data.headRevision?.savedAt,
      )}
      persistedMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
      readOnlyPreview={Boolean(readOnlyPreview)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <Link
            href={virtualPreview
              ? `/grants/${encodeURIComponent(grantId)}?biz=${encodeURIComponent(virtualPreview.bizNo)}`
              : adminPreview
                ? `/grants/${encodeURIComponent(grantId)}?adminPreview=1`
                : `/grants/${encodeURIComponent(grantId)}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            공고 요약
          </Link>
          <h1 className="truncate text-base font-semibold sm:text-lg">{data.grant.title}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {progress ? (
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {progress.confirmed.toLocaleString("ko-KR")}/{progress.total.toLocaleString("ko-KR")} 확인 완료
              </span>
              <Progress
                value={progress.total > 0 ? Math.round((progress.confirmed / progress.total) * 100) : 0}
                className="w-24"
                aria-label="확인 완료 진행률"
              />
              {!integratedFieldEditor && progress.studio.total > 0 ? (
                <span className="hidden text-[11px] text-muted-foreground xl:inline">
                  빠른 작성 {progress.quick.confirmed}/{progress.quick.total} · 문서 편집 {progress.studio.confirmed}/{progress.studio.total}
                </span>
              ) : null}
            </div>
          ) : null}
          {canOpenStudio && !integratedFieldEditor ? (
            <ToggleGroup
              value={[authoringMode]}
              onValueChange={(value) => {
                const next = value.at(-1);
                if (next === "studio") openStudio();
                if (next === "quick" && authoringMode === "studio") void studioSurfaceRef.current?.saveAndReturn();
              }}
              size="sm"
              variant="outline"
              spacing={0}
              aria-label="문서 작성 방식"
            >
              <ToggleGroupItem value="quick">
                <WandSparkles data-icon="inline-start" aria-hidden />
                빠른 작성
              </ToggleGroupItem>
              <ToggleGroupItem value="studio">
                <FilePenLine data-icon="inline-start" aria-hidden />
                문서 직접 편집
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          {data.ladder === "a" && !integratedFieldEditor && authoringMode === "quick" ? (
            <ToggleGroup
              value={[panelMode]}
              onValueChange={(value) => {
                const next = value.at(-1);
                if (next === "single" || next === "list") setPanelMode(next);
              }}
              size="sm"
              variant="outline"
              spacing={0}
              aria-label="작성 항목 보기 방식"
            >
              <ToggleGroupItem value="single">하나씩</ToggleGroupItem>
              <ToggleGroupItem value="list">전체 목록</ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          {data.documents.length > 1 && data.activeDocumentKey ? (
            <Select
              value={data.activeDocumentKey}
              disabled={pendingLabels.size > 0 || suggestingLabels.size > 0 || integratedFieldEditor || authoringMode === "studio"}
              // Base UI Select 는 items 를 줘야 SelectValue 가 raw value(documentKey) 대신 label 을 렌더한다.
              items={data.documents.map((document) => ({ value: document.documentKey, label: document.label }))}
              onValueChange={(next) => {
                if (next && next !== data.activeDocumentKey) {
                  const params = new URLSearchParams({ document: next });
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
          <strong className="text-brand">{adminPreview ? "관리자 빠른 작성 시뮬레이션" : "가상 기업 작성 미리보기"}</strong>
          <span className="ml-2">
            {readOnlyPreview.companyName} 기준으로 열었어요. 자동으로 연결 가능한 기업정보만 제안되며, 이 탭에서 바꾼 값은 새로고침하면 초기화되고 실제 회사·초안에는 저장되지 않습니다.
          </span>
        </div>
      ) : null}

      {authoringMode !== "studio" && data.ladder !== "c" && data.honestNotice ? (
        <div className="mx-3 mt-3 rounded-[var(--radius-lg)] border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-800 dark:text-amber-300 lg:mx-4">
          {data.honestNotice}
        </div>
      ) : null}

      {integratedFieldEditor && studioTransport ? (
        <>
          <div
            data-field-aware-editor
            className="grid min-h-0 flex-1 gap-4 overflow-auto p-3 xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden xl:p-4"
          >
            <div className="flex min-h-[72dvh] min-w-0 xl:min-h-0">
              <RhwpStudioSurface
                key={currentStudioSourceKey}
                ref={studioSurfaceRef}
                transport={studioTransport}
                answers={answers}
                quickFields={quickFields}
                connectedFields={rhwpFields}
                manualAnchors={manualAnchors}
                duplicateLabels={duplicateSet}
                workingDocument={workingDocument}
                headMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
                activeTask={taskByFieldId.get(selectedFieldId ?? "") ?? null}
                documentAgentAvailable={false}
                fieldEditorAgentAvailable={data.fieldEditorAgentAvailable}
                presentation="field_aware"
                onFieldBindingsResolved={handleFieldBindingsResolved}
                onFieldSelectionChanged={handleStudioFieldSelection}
                onSaved={handleStudioSaved}
              />
            </div>
            <div className="hidden min-h-0 xl:block">
              <FieldAgentRail
                session={fieldAgentSession}
                connectedFields={data.connectedFields}
                run={selectedFieldId ? fieldAgentRuns.get(selectedFieldId) ?? null : null}
                onSelectField={handleSelectField}
                onRequestSuggestion={requestSuggestion}
                onStartConversation={(field) => void handleAskField(field)}
                onApplySuggestion={(run, suggestion) => void runFieldAgentAction("apply", run, suggestion)}
                onUndoSuggestion={(run, suggestion) => void runFieldAgentAction("undo", run, suggestion)}
                onDismissSuggestion={(run, suggestion) => void runFieldAgentAction("dismiss", run, suggestion)}
              />
            </div>
          </div>
          <div className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-3 rounded-xl border bg-background/95 p-2.5 shadow-lg backdrop-blur xl:hidden">
            <div className="min-w-0 flex-1 px-1">
              <p className="text-[11px] font-medium text-muted-foreground">현재 필드</p>
              <p className="truncate text-sm font-semibold">{fieldAgentSession.selected?.label ?? "작성 항목 선택"}</p>
            </div>
            <Button type="button" size="sm" onClick={() => setShowFieldAgent(true)}>
              <WandSparkles data-icon="inline-start" aria-hidden />
              AI 도우미
            </Button>
          </div>
          <Sheet open={showFieldAgent} onOpenChange={setShowFieldAgent}>
            <SheetContent className="flex w-full flex-col gap-0 p-3 sm:max-w-md xl:hidden">
              <SheetTitle className="sr-only">AI 필드 도우미</SheetTitle>
              <SheetDescription className="sr-only">
                현재 문서의 필드를 선택하고 근거 있는 값을 제안받아 정확한 입력 칸에 반영합니다.
              </SheetDescription>
              <div className="min-h-0 flex-1 pt-8">
                <FieldAgentRail
                  session={fieldAgentSession}
                  connectedFields={data.connectedFields}
                  run={selectedFieldId ? fieldAgentRuns.get(selectedFieldId) ?? null : null}
                  onSelectField={handleSelectField}
                  onRequestSuggestion={requestSuggestion}
                  onStartConversation={(field) => void handleAskField(field)}
                  onApplySuggestion={(run, suggestion) => void runFieldAgentAction("apply", run, suggestion)}
                  onUndoSuggestion={(run, suggestion) => void runFieldAgentAction("undo", run, suggestion)}
                  onDismissSuggestion={(run, suggestion) => void runFieldAgentAction("dismiss", run, suggestion)}
                />
              </div>
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      {!integratedFieldEditor && studioSourceKey === currentStudioSourceKey && studioTransport ? (
        <div className={authoringMode === "studio" ? "flex min-h-0 flex-1" : "hidden"}>
          <RhwpStudioSurface
            key={currentStudioSourceKey}
            ref={studioSurfaceRef}
            transport={studioTransport}
            answers={answers}
            quickFields={quickFields}
            connectedFields={rhwpFields}
            manualAnchors={manualAnchors}
            duplicateLabels={duplicateSet}
            workingDocument={workingDocument}
            headMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
            activeTask={studioTasks.find((task) => task.fieldId === selectedFieldId) ?? null}
            documentAgentAvailable={data.documentAgentAvailable}
            onSaved={handleStudioSaved}
          />
        </div>
      ) : null}

      {integratedFieldEditor || authoringMode === "studio" ? null : data.ladder === "c" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
            {data.honestNotice ? (
              <div className="rounded-[var(--radius-lg)] border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                {data.honestNotice}
              </div>
            ) : null}
            {readOnlyPreview ? (
              <div className="rounded-[var(--radius-lg)] border bg-card px-4 py-5 text-sm text-muted-foreground">
                읽기 전용 시뮬레이션에서는 저장이나 AI 작성을 실행하지 않습니다. 작성 항목이 준비된 공고에서 입력 흐름을 확인해 주세요.
              </div>
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
      ) : (
        // 프리뷰를 데스크톱/모바일용으로 두 번 mount하면 원본 파싱·WASM 메모리도 두 배가 된다.
        // 동일 노드 하나를 반응형 레이아웃만 바꿔 사용한다.
        <div className="min-h-0 flex-1 overflow-auto p-3 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)] lg:gap-4 lg:overflow-hidden lg:p-4">
          <div className="h-52 overflow-hidden rounded-[var(--radius-xl)] lg:h-auto lg:min-h-0 lg:overflow-visible lg:rounded-none">
            {previewCanvas}
          </div>
          <div className="mt-3 lg:min-h-0 lg:mt-0 lg:overflow-auto">{fieldPanel}</div>
        </div>
      )}

      {/* 1:1 채팅 Dialog 오버레이(§2-④) — 닫으면 확인 루프가 그 자리에 그대로 있다. */}
      {data.ladder === "a" && !readOnlyPreview ? (
        <Dialog open={showChat} onOpenChange={setShowChat}>
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-3 sm:max-w-2xl">
            <DialogTitle className="sr-only">이 공고에 대해 물어보기</DialogTitle>
            <DialogDescription className="sr-only">
              공고 내용·자격·마감·작성 요령을 채팅으로 물어볼 수 있어요.
            </DialogDescription>
            <div className="min-h-0 overflow-y-auto pt-6 sm:pt-2">
              <ChatPanelView
                controller={chat}
                greeting={greeting}
                variant="front"
                institutionContact={institutionContact}
                onApplyFieldProposal={({ fieldId, label, value, runId, suggestionId }) => {
                  if (integratedFieldEditor) {
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
                    return;
                  }
                  void patchAnswer(label, { value, status: "accepted" });
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {data.pollConversion ? <ConversionPollTrigger grantId={grantId} /> : null}
      {data.fieldAnalysisRecoveryNeeded && data.draftId && !readOnlyPreview ? (
        <ApplicationFieldAnalysisTrigger draftId={data.draftId} />
      ) : null}
    </div>
  );
}
