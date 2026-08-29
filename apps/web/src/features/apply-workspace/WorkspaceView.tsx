"use client";

/**
 * RHWP 작성 workspace 오케스트레이터.
 * HWP/HWPX는 필드 결속 유무와 관계없이 RHWP + 우측 AI 작성 가이드로 열고,
 * RHWP 비지원 문서만 채팅 fallback으로 보낸다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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

const EMPTY_MATERIALIZED_ANSWERS: Record<string, string> = {};
const EMPTY_RHWP_ANCHORS: readonly RhwpFieldAnchor[] = [];
// 구형 quick/studio 완료 상태는 통합 RHWP 작업공간의 렌더 계약에 포함하지 않는다.

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
  const [suggestingLabels, setSuggestingLabels] = useState<Set<string>>(() => new Set());
  const [showChat, setShowChat] = useState(false);
  const [showFieldAgent, setShowFieldAgent] = useState(false);
  const [workingDocument, setWorkingDocument] = useState<RhwpWorkingDocument | null>(null);
  const [studioDocumentActions, setStudioDocumentActions] = useState<RhwpStudioDocumentActionState>({
    saveState: initialStudioSaveState,
    saving: false,
    downloading: false,
    canSave: false,
    canDownload: false,
  });
  const [fieldBindingsResolved, setFieldBindingsResolved] = useState(false);
  const [fieldBindingStatuses, setFieldBindingStatuses] = useState<Map<string, "unique" | "missing" | "ambiguous">>(
    () => new Map(),
  );
  const [fieldBindingTargets, setFieldBindingTargets] = useState<Map<string, StudioFieldBindingTargetV1>>(() => new Map());
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
    setWorkingDocument(null);
    setStudioDocumentActions({
      saveState: initialStudioSaveState,
      saving: false,
      downloading: false,
      canSave: false,
      canDownload: false,
    });
    setFieldBindingsResolved(false);
    setFieldBindingStatuses(new Map());
    setFieldBindingTargets(new Map());
    setFieldAgentRuns(new Map());
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
                : `/grants/${encodeURIComponent(grantId)}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            공고 요약
          </Link>
          <h1 className="truncate text-base font-semibold sm:text-lg">{data.grant.title}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {data.documents.length > 1 && data.activeDocumentKey ? (
            <Select
              value={data.activeDocumentKey}
              disabled={suggestingLabels.size > 0}
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
          <strong className="text-brand">{adminPreview ? "관리자 RHWP 작성 시뮬레이션" : "가상 기업 RHWP 작성 미리보기"}</strong>
          <span className="ml-2">
            {readOnlyPreview.companyName} 기준으로 열었어요. 자동으로 연결 가능한 기업정보만 제안되며, 이 탭에서 바꾼 값은 새로고침하면 초기화되고 실제 회사·초안에는 저장되지 않습니다.
          </span>
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
                manualAnchors={EMPTY_RHWP_ANCHORS}
                duplicateLabels={duplicateSet}
                workingDocument={workingDocument}
                headMaterializedAnswers={data.headRevision?.materializedAnswers ?? EMPTY_MATERIALIZED_ANSWERS}
                activeTask={taskByFieldId.get(selectedFieldId ?? "") ?? null}
                documentAgentAvailable={false}
                fieldEditorAgentAvailable={data.fieldEditorAgentAvailable}
                presentation="field_aware"
                onDocumentActionStateChanged={setStudioDocumentActions}
                onFieldBindingsResolved={handleFieldBindingsResolved}
                onFieldSelectionChanged={handleStudioFieldSelection}
                onSaved={handleStudioSaved}
              />
            </div>
            <div className="hidden h-full min-h-0 overflow-hidden xl:block">
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
            </div>
          </div>
          <div className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-3 rounded-xl border bg-background/95 p-2.5 shadow-lg backdrop-blur xl:hidden">
            <div className="min-w-0 flex-1 px-1">
              <p className="text-[11px] font-medium text-muted-foreground">현재 필드</p>
              <p className="truncate text-sm font-semibold">{fieldAgentSession.selected?.label ?? "작성 항목 선택"}</p>
            </div>
            <Button type="button" size="sm" onClick={() => setShowFieldAgent(true)}>
              <WandSparkles data-icon="inline-start" aria-hidden />
              AI 작성 가이드
            </Button>
          </div>
          <Sheet open={showFieldAgent} onOpenChange={setShowFieldAgent}>
            <SheetContent className="flex w-full flex-col gap-0 p-3 sm:max-w-md xl:hidden">
              <SheetTitle className="sr-only">AI 작성 가이드</SheetTitle>
              <SheetDescription className="sr-only">
                현재 문서의 필드를 선택하고 근거 있는 값을 제안받아 정확한 입력 칸에 반영합니다.
              </SheetDescription>
              <div className="h-full min-h-0 flex-1 overflow-hidden pt-8">
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
              </div>
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      {integratedRhwpWorkspace && !integratedFieldEditor && studioTransport ? (
        <div data-document-guided-editor className="flex min-h-0 flex-1 p-3 xl:p-4">
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
            onSaved={handleStudioSaved}
          />
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
      {integratedFieldEditor && !readOnlyPreview ? (
        <Dialog open={showChat} onOpenChange={setShowChat}>
          <DialogContent className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-4 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-7xl sm:p-5">
            <DialogTitle className="sr-only">이 공고에 대해 물어보기</DialogTitle>
            <DialogDescription className="sr-only">
              공고 내용·자격·마감·작성 요령을 채팅으로 물어볼 수 있어요.
            </DialogDescription>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-7 sm:pt-3">
              <ChatPanelView
                controller={chat}
                greeting={greeting}
                variant="front"
                fillAvailableHeight
                institutionContact={institutionContact}
                onApplyFieldProposal={({ fieldId, value, runId, suggestionId }) => {
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

      {data.pollConversion ? <ConversionPollTrigger grantId={grantId} /> : null}
    </div>
  );
}
