"use client";

/**
 * 작성 도우미 workspace 오케스트레이터 (Apply Experience v2 · §4.3/§4.4 · P2-5).
 *
 * 데스크톱 3영역(좌 프리뷰 ≈60% / 우상 필드 패널 / 우하 채팅) · 모바일 3탭(문서/필드/채팅).
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
import type { ActionResult } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { FieldPanel } from "./FieldPanel";
import { WorkspaceFooter, type WorkspaceProgress } from "./WorkspaceFooter";

const LADDER_BADGE: Record<WorkspaceData["ladder"], { label: string; className: string }> = {
  a: { label: "원본 양식 채움", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  b: { label: "필드 분석 중", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  c: { label: "채팅으로 안내", className: "border-border bg-muted/50 text-muted-foreground" },
};

export function WorkspaceView({
  grantId,
  data,
  greeting,
}: {
  grantId: string;
  data: WorkspaceData;
  greeting: ChatMessageContent;
}) {
  const [answers, setAnswers] = useState<DraftFieldAnswers>(data.fieldAnswers);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState("doc");
  const chat = useGrantChat({ grantId, draftId: data.draftId });
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const duplicateSet = useMemo(() => new Set(data.duplicateLabels), [data.duplicateLabels]);

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
      const answer = answers[answerKey(field.label)];
      const isConfirmed = answer?.status === "accepted" || answer?.status === "edited";
      if (isConfirmed) confirmed += 1;
      if (field.required) {
        requiredTotal += 1;
        if (isConfirmed) requiredConfirmed += 1;
      }
    }
    return { total: data.connectedFields.length, confirmed, requiredTotal, requiredConfirmed };
  }, [data.ladder, data.connectedFields, answers]);

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
    setError(null);
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
    } catch (caught) {
      // 실패한 이 필드(key)만 패치 이전 값으로 되돌린다 — 전체 맵 롤백은 그 사이 완료된
      // 다른 필드의 성공 결과까지 되돌려버리는 교차-필드 클로버 버그였다.
      setAnswers((cur) => {
        const next = { ...cur };
        if (prev[key] === undefined) delete next[key];
        else next[key] = prev[key];
        return next;
      });
      setError(caught instanceof Error ? caught.message : "필드 답변을 저장하지 못했습니다.");
    } finally {
      setPendingLabels((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function handleAskField(field: ConnectedDocumentField) {
    chat.askField({ label: field.label, section: field.section, fieldId: field.fieldId });
    setMobileTab("chat"); // 모바일에서 답변이 보이도록 채팅 탭으로 전환.
  }

  const badge = LADDER_BADGE[data.ladder];

  const previewCanvas = (
    <PreviewCanvas
      grantId={grantId}
      grantTitle={data.grant.title}
      pages={data.pages}
      overlayFields={overlayFields}
      selectedFieldId={selectedFieldId}
      onSelectField={setSelectedFieldId}
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
      fieldLessonTips={data.fieldLessonTips}
      missingFields={data.missingFields}
      selectedFieldId={selectedFieldId}
      pendingLabels={pendingLabels}
      onSelectField={setSelectedFieldId}
      patchAnswer={patchAnswer}
      onAskField={handleAskField}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
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
        <Badge variant="outline" className={badge.className}>
          {badge.label}
        </Badge>
      </div>

      {error ? (
        <div className="flex items-center gap-1.5 border-b bg-destructive/[0.06] px-4 py-2 text-sm text-destructive" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      {data.ladder === "c" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
            {data.honestNotice ? (
              <div className="rounded-[var(--radius-lg)] border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                {data.honestNotice}
              </div>
            ) : null}
            <ChatPanelView controller={chat} greeting={greeting} variant="front" />
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
          {/* 데스크톱 3영역 */}
          <div className="hidden min-h-0 flex-1 gap-4 p-4 lg:grid lg:grid-cols-[minmax(0,1.55fr)_minmax(380px,1fr)]">
            {previewCanvas}
            <div className="flex min-h-0 flex-col gap-4">
              <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-xl)] border bg-card">
                {fieldPanel}
              </div>
              <ChatPanelView controller={chat} greeting={greeting} />
            </div>
          </div>

          {/* 모바일 3탭 */}
          <div className="min-h-0 flex-1 overflow-hidden p-3 lg:hidden">
            <Tabs value={mobileTab} onValueChange={(value) => setMobileTab(String(value))} className="h-full">
              <TabsList className="w-full">
                <TabsTrigger value="doc">문서</TabsTrigger>
                <TabsTrigger value="fields">필드</TabsTrigger>
                <TabsTrigger value="chat">채팅</TabsTrigger>
              </TabsList>
              <TabsContent value="doc" className="min-h-0 overflow-auto">
                {previewCanvas}
              </TabsContent>
              <TabsContent value="fields" className="min-h-0 overflow-auto rounded-[var(--radius-xl)] border bg-card">
                {fieldPanel}
              </TabsContent>
              <TabsContent value="chat" className="min-h-0 overflow-auto">
                <ChatPanelView controller={chat} greeting={greeting} variant="front" />
              </TabsContent>
            </Tabs>
          </div>
        </>
      )}

      <WorkspaceFooter
        grantId={grantId}
        documents={data.documents}
        activeDocumentKey={data.activeDocumentKey}
        draftId={data.draftId}
        hwpxTemplateAvailable={data.hwpxTemplateAvailable}
        progress={progress}
      />

      {data.pollConversion ? <ConversionPollTrigger grantId={grantId} /> : null}
    </div>
  );
}
