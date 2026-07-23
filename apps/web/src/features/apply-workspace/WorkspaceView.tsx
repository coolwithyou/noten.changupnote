"use client";

/**
 * 작성 도우미 workspace 오케스트레이터 (Apply Experience v2 · 재정의 2026-07-15).
 *
 * 이 화면이 답하는 질문은 단 하나 — "이 칸에 이 값을 넣어도 되나요?". 조종석에 보이는 것은
 * 미리보기 + 확인 카드 1장 + 진행 표시 3가지뿐이다(재정의 §0). 사다리·ladder·draft 등 내부
 * 어휘는 화면에 노출하지 않는다.
 *
 * 상단 바(재정의 §2-①): ← 공고 요약 / 공고명 / M/N 확인 완료(단일 축) / 하나씩·전체 목록 토글 /
 *   문서 Select(2개 이상일 때만). 채팅은 패널 대체가 아니라 Sheet 오버레이(§2-④) — 닫으면 루프가
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
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { parsePositionBbox, parsePositionPage } from "@/lib/documents/bbox";
import { extractFieldOptions } from "@/lib/documents/fieldOptions";
import type { RhwpFieldAnchor, RhwpFieldDescriptor } from "@/lib/rhwp/fieldAnchors";
import type { RhwpWorkingDocument } from "@/lib/rhwp/workingDocument";
import type { DraftFieldAnswers, DraftFieldAnswerStatus } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { WorkspaceData } from "@/lib/server/documents/workspaceData";
import type { ChatMessageContent } from "@/lib/chat/messageContent";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { PreviewCanvas, type PreviewOverlayField } from "@/features/document-viewer/PreviewCanvas";
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
import { RhwpStudioSurface, type RhwpStudioSurfaceHandle } from "./RhwpStudioSurface";
import { workspaceFieldState, type InstitutionContact } from "./workspacePresentation";

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
  const router = useRouter();
  const [answers, setAnswers] = useState<DraftFieldAnswers>(data.fieldAnswers);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(() => new Set());
  const [suggestingLabels, setSuggestingLabels] = useState<Set<string>>(() => new Set());
  const [panelMode, setPanelMode] = useState<WorkspacePanelMode>("single");
  const [showChat, setShowChat] = useState(false);
  const [rhwpAnchorsReady, setRhwpAnchorsReady] = useState(false);
  const [locatingFieldId, setLocatingFieldId] = useState<string | null>(null);
  const [manualAnchors, setManualAnchors] = useState<RhwpFieldAnchor[]>([]);
  const [authoringMode, setAuthoringMode] = useState<Extract<DocumentAuthoringMode, "quick" | "studio">>("quick");
  const [studioDraftId, setStudioDraftId] = useState<string | null>(null);
  const [studioTaskStates, setStudioTaskStates] = useState<StudioTaskStates>({});
  const [workingDocument, setWorkingDocument] = useState<RhwpWorkingDocument | null>(null);
  const [workingPreviewUrl, setWorkingPreviewUrl] = useState<string | null>(null);
  const studioSurfaceRef = useRef<RhwpStudioSurfaceHandle | null>(null);
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

  useEffect(() => {
    setAuthoringMode("quick");
    setStudioDraftId(null);
    setStudioTaskStates({});
    setWorkingDocument(null);
  }, [data.draftId]);

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
            && workingDocument?.materializedAnswers[field.fieldId] === answer.value,
          ),
          isChoiceField: options.length > 0,
          visualEvidence: field.visualEvidence,
          authoringMode: task?.mode === "studio" ? "studio" : "quick",
        };
      }),
    [data.connectedFields, answers, duplicateSet, studioTaskStates, taskByFieldId, workingDocument],
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

  async function patchAnswer(label: string, entry: { value?: string; status: DraftFieldAnswerStatus }) {
    if (!data.draftId) return;
    const key = answerKey(label);
    const prev = answersRef.current;
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

  async function requestSuggestion(field: ConnectedDocumentField) {
    if (!data.draftId) return;
    const key = answerKey(field.label);
    const existing = answersRef.current[key];
    // 값이 이미 있으면(제안 상태) '다시 제안', 없으면 최초 '제안 받기'.
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
            ...(mode === "regenerate" && existing?.value ? { currentValue: existing.value } : {}),
          }),
        },
      );
      const payload = (await response.json()) as ActionResult<{
        suggestions: Record<string, { value: string; basis: string }>;
      }>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "제안을 생성하지 못했습니다.");
      }
      // 응답 suggestions 는 이미 서버가 suggested/llm 로 저장한 값이다(저장-반환 일치). 로컬 반영만 한다.
      const suggestion = payload.data.suggestions[field.label] ?? payload.data.suggestions[key];
      if (!suggestion) {
        toast.error("근거 있는 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setAnswers((cur) => {
        const prevEntry = cur[key];
        const nextEntry: DraftFieldAnswers[string] = {
          value: suggestion.value,
          status: "suggested",
          source: "llm",
          suggestedValue: suggestion.value,
          basis: suggestion.basis,
          updatedAt: new Date().toISOString(),
        };
        if (prevEntry?.fieldId !== undefined) nextEntry.fieldId = prevEntry.fieldId;
        return { ...cur, [key]: nextEntry };
      });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "제안을 생성하지 못했습니다.");
    } finally {
      setSuggestingLabels((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function handleAskField(field: ConnectedDocumentField) {
    chat.askField({ label: field.label, section: field.section, fieldId: field.fieldId });
    setShowChat(true);
  }

  function handleSelectField(fieldId: string) {
    setSelectedFieldId(fieldId);
    setLocatingFieldId(null);
    setPanelMode("single");
  }

  function openStudio(fieldId?: string) {
    if (!data.draftId) {
      toast.error("원본 문서가 준비된 뒤 직접 편집할 수 있습니다.");
      return;
    }
    const target = (fieldId ? taskByFieldId.get(fieldId) : null)
      ?? studioTasks.find((task) => task.fieldId === selectedFieldId)
      ?? studioTasks.find((task) => !isAuthoringTaskComplete({ task, answers, studioTaskStates }))
      ?? studioTasks[0];
    if (!target) return;
    setSelectedFieldId(target.fieldId);
    setStudioDraftId(data.draftId);
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
      rhwpSourceUrl={(workingDocument?.draftId === data.draftId ? workingPreviewUrl : null) ?? (data.draftId
        ? `/api/web/document-drafts/${encodeURIComponent(data.draftId)}/source-file`
        : null)}
      rhwpFields={rhwpFields}
      manualAnchors={manualAnchors}
      locatingFieldId={locatingFieldId}
      onLocateField={handleLocateField}
      onRhwpAnchorsChange={handleRhwpAnchorsChange}
    />
  );

  const fieldPanel = (
    <FieldPanel
      ladder={data.ladder}
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
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <Link
            href={`/grants/${encodeURIComponent(grantId)}`}
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
              {progress.studio.total > 0 ? (
                <span className="hidden text-[11px] text-muted-foreground xl:inline">
                  빠른 작성 {progress.quick.confirmed}/{progress.quick.total} · 문서 편집 {progress.studio.confirmed}/{progress.studio.total}
                </span>
              ) : null}
            </div>
          ) : null}
          {data.ladder === "a" && studioTasks.length > 0 ? (
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
          {data.ladder === "a" && authoringMode === "quick" ? (
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
              disabled={pendingLabels.size > 0 || suggestingLabels.size > 0 || authoringMode === "studio"}
              // Base UI Select 는 items 를 줘야 SelectValue 가 raw value(documentKey) 대신 label 을 렌더한다.
              items={data.documents.map((document) => ({ value: document.documentKey, label: document.label }))}
              onValueChange={(next) => {
                if (next && next !== data.activeDocumentKey) {
                  router.push(`/grants/${encodeURIComponent(grantId)}/workspace?document=${encodeURIComponent(next)}`);
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

      {studioDraftId === data.draftId && data.draftId ? (
        <div className={authoringMode === "studio" ? "flex min-h-0 flex-1" : "hidden"}>
          <RhwpStudioSurface
            key={data.draftId}
            ref={studioSurfaceRef}
            draftId={data.draftId}
            answers={answers}
            quickFields={quickFields}
            manualAnchors={manualAnchors}
            duplicateLabels={duplicateSet}
            workingDocument={workingDocument}
            activeTask={studioTasks.find((task) => task.fieldId === selectedFieldId) ?? null}
            onSaved={handleStudioSaved}
          />
        </div>
      ) : null}

      {authoringMode === "studio" ? null : data.ladder === "c" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
            {data.honestNotice ? (
              <div className="rounded-[var(--radius-lg)] border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                {data.honestNotice}
              </div>
            ) : null}
            <ChatPanelView
              controller={chat}
              greeting={greeting}
              variant="front"
              institutionContact={institutionContact}
            />
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

      {/* 채팅 Sheet 오버레이(§2-④) — 닫으면 확인 루프가 그 자리에 그대로 있다. 진입점(💬)은 (a) 확인 카드뿐. */}
      {data.ladder === "a" ? (
        <Sheet open={showChat} onOpenChange={setShowChat}>
          <SheetContent className="flex w-full flex-col gap-0 p-3 sm:max-w-md">
            <SheetTitle className="sr-only">이 공고에 대해 물어보기</SheetTitle>
            <SheetDescription className="sr-only">
              공고 내용·자격·마감·작성 요령을 채팅으로 물어볼 수 있어요.
            </SheetDescription>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-6">
              <ChatPanelView
                controller={chat}
                greeting={greeting}
                variant="front"
                institutionContact={institutionContact}
                onApplyFieldProposal={({ label, value }) => {
                  void patchAnswer(label, { value, status: "accepted" });
                }}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      {data.pollConversion ? <ConversionPollTrigger grantId={grantId} /> : null}
    </div>
  );
}
