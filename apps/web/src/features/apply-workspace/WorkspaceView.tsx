"use client";

/**
 * 작성 도우미 workspace 오케스트레이터 (Apply Experience v2 · §4.3/§4.4 · P2-5).
 *
 * 데스크톱 2영역(좌 프리뷰 60% / 우 인터뷰 또는 채팅 40%) · 모바일 프리뷰+필드 스택.
 * `selectedFieldId` 를 보유해 오버레이↔카드 양방향 동기화를 이룬다. 필드 값 변경은 전부
 * PATCH /field-answers 로만(낙관적 업데이트→서버 응답 동기화, 실패 시 롤백).
 *
 * 사다리:
 *  (a) 프리뷰+오버레이+필드 카드 + HWPX 다운로드
 *  (b) 프리뷰 + "필드 분석 중" + missingFields 질문 카드(진행률 숨김)
 *  (c) 채팅 전면 + DraftFallbackEditor(초안 편집기) 폴백 + 정직 고지
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { parsePositionBbox, parsePositionPage } from "@/lib/documents/bbox";
import type { DraftFieldAnswers, DraftFieldAnswerStatus } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { WorkspaceData } from "@/lib/server/documents/workspaceData";
import type { ChatMessageContent } from "@/lib/chat/messageContent";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { PreviewCanvas, type PreviewOverlayField } from "@/features/document-viewer/PreviewCanvas";
import { answerKey, fieldVisualState, optimisticApply } from "./fieldAnswerState";
import { ChatPanelView, useGrantChat } from "./ChatPanel";
import { DraftFallbackEditor } from "./DraftFallbackEditor";
import { FieldPanel, type WorkspacePanelMode } from "./FieldPanel";
import { ProgressMeter, WorkspaceFooter, type WorkspaceProgress } from "./WorkspaceFooter";
import { workspaceFieldState, type InstitutionContact } from "./workspacePresentation";

const LADDER_BADGE: Record<WorkspaceData["ladder"], { label: string; className: string }> = {
  a: { label: "원본 양식 채움", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  b: { label: "필드 분석 중", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  c: { label: "채팅으로 안내", className: "border-border bg-muted/50 text-muted-foreground" },
};

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
  const [answers, setAnswers] = useState<DraftFieldAnswers>(data.fieldAnswers);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(() => new Set());
  const [suggestingLabels, setSuggestingLabels] = useState<Set<string>>(() => new Set());
  const [panelMode, setPanelMode] = useState<WorkspacePanelMode>("single");
  const [showChat, setShowChat] = useState(false);
  const chat = useGrantChat({ grantId, draftId: data.draftId });
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const duplicateSet = useMemo(() => new Set(data.duplicateLabels), [data.duplicateLabels]);
  const suggestableSet = useMemo(() => new Set(data.suggestableLabels), [data.suggestableLabels]);

  useEffect(() => {
    if (selectedFieldId || data.connectedFields.length === 0) return;
    const first = data.connectedFields.find((field) =>
      workspaceFieldState(answers[answerKey(field.label)]) !== "filled",
    );
    if (first) setSelectedFieldId(first.fieldId);
  }, [selectedFieldId, data.connectedFields, answers]);

  const overlayFields = useMemo<PreviewOverlayField[]>(
    () =>
      data.connectedFields.map((field) => ({
        fieldId: field.fieldId,
        label: field.label,
        page: parsePositionPage(field.position),
        box: parsePositionBbox(field.position),
        state: fieldVisualState(field.label, answers, duplicateSet),
      })),
    [data.connectedFields, answers, duplicateSet],
  );

  const progress = useMemo<WorkspaceProgress | null>(() => {
    if (data.ladder !== "a" || data.connectedFields.length === 0) return null;
    let confirmed = 0;
    let requiredTotal = 0;
    let requiredConfirmed = 0;
    for (const field of data.connectedFields) {
      const key = answerKey(field.label);
      const answer = answers[key];
      const isConfirmed =
        !pendingLabels.has(key) && (answer?.status === "accepted" || answer?.status === "edited");
      if (isConfirmed) confirmed += 1;
      if (field.required) {
        requiredTotal += 1;
        if (isConfirmed) requiredConfirmed += 1;
      }
    }
    return { total: data.connectedFields.length, confirmed, requiredTotal, requiredConfirmed };
  }, [data.ladder, data.connectedFields, answers, pendingLabels]);

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
        const currentIndex = data.connectedFields.findIndex((field) => answerKey(field.label) === key);
        const optimistic = optimisticApply(prev, key, entry);
        const ordered = data.connectedFields
          .slice(currentIndex + 1)
          .concat(data.connectedFields.slice(0, Math.max(0, currentIndex)));
        const next = ordered.find((field) =>
          workspaceFieldState(optimistic[answerKey(field.label)]) !== "filled",
        );
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
    setPanelMode("single");
    setShowChat(false);
  }

  const badge = LADDER_BADGE[data.ladder];

  const previewCanvas = (
    <PreviewCanvas
      grantId={grantId}
      grantTitle={data.grant.title}
      pages={data.pages}
      overlayFields={overlayFields}
      selectedFieldId={selectedFieldId}
      onSelectField={handleSelectField}
      fill
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
            공고 요약으로
          </Link>
          <h1 className="truncate text-base font-semibold sm:text-lg">{data.grant.title}</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {progress ? <ProgressMeter progress={progress} /> : null}
          {data.ladder !== "c" ? (
            <ToggleGroup
              value={[panelMode]}
              onValueChange={(value) => {
                const next = value.at(-1);
                if (next === "single" || next === "list") {
                  setPanelMode(next);
                  setShowChat(false);
                }
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
          <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
        </div>
      </div>

      {data.ladder === "c" ? (
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
            <DraftFallbackEditor
              grantId={grantId}
              prep={data.prep}
              initialDrafts={data.initialDrafts}
              fieldLessonTips={data.fieldLessonTips}
            />
          </div>
        </div>
      ) : (
        <>
          {/* 데스크톱: 문서 60% + 인터뷰/채팅 40% */}
          <div className="hidden min-h-0 flex-1 gap-4 p-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(380px,2fr)]">
            {previewCanvas}
            <div className="min-h-0 overflow-auto rounded-[var(--radius-xl)] border bg-card">
              {showChat ? (
                <ChatPanelView
                  controller={chat}
                  greeting={greeting}
                  variant="front"
                  institutionContact={institutionContact}
                  onClose={() => setShowChat(false)}
                />
              ) : fieldPanel}
            </div>
          </div>

          {/* 모바일: 첫 화면은 프리뷰 요약 + 필드, 채팅은 질문했을 때만 대체 화면으로 연다. */}
          <div className="min-h-0 flex-1 overflow-auto p-3 lg:hidden">
            {showChat ? (
              <div className="min-h-full overflow-hidden rounded-[var(--radius-xl)] border bg-card">
                <ChatPanelView
                  controller={chat}
                  greeting={greeting}
                  variant="front"
                  institutionContact={institutionContact}
                  onClose={() => setShowChat(false)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="h-52 overflow-hidden rounded-[var(--radius-xl)]">
                  {previewCanvas}
                </div>
                <div className="overflow-hidden rounded-[var(--radius-xl)] border bg-card">
                  {fieldPanel}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <WorkspaceFooter
        grantId={grantId}
        documents={data.documents}
        activeDocumentKey={data.activeDocumentKey}
        draftId={data.draftId}
        hwpxTemplateAvailable={data.hwpxTemplateAvailable}
        progress={null}
        answersSaving={pendingLabels.size > 0}
      />

      {data.pollConversion ? <ConversionPollTrigger grantId={grantId} /> : null}
    </div>
  );
}
