"use client";

/**
 * 필드 카드 1개 (Apply Experience v2 · §4.3 컨펌 규약 · P2-6).
 *
 * 라벨 · 상태 뱃지(숫자 신뢰도 금지, 라벨만) · 값(제안이면 파선 구분) · 액션(반영/수정/건너뛰기) · undo
 * · "이 항목이 뭐예요?"(Phase 3 채팅 프리필용 — 지금은 비활성) · FieldLessonTips 재사용 · 위치 미확인 뱃지
 * · 동일 항목명 경고 뱃지.
 *
 * 액션은 상위(WorkspaceView)의 patchAnswer 로 위임되며 낙관적 업데이트→PATCH 응답 동기화는 거기서 처리한다.
 */
import { useEffect, useRef, useState } from "react";
import { Check, HelpCircle, Loader2, MapPinOff, Pencil, RotateCcw, SkipForward, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FieldLessonTips } from "@/features/knowledge/FieldLessonTips";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswer } from "@/lib/server/documents/fieldAnswers";

interface StatusBadgeMeta {
  text: string;
  className: string;
}

const SKY = "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400";
const EMERALD = "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
const MUTED = "border-border bg-muted/50 text-muted-foreground";
const AMBER = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";

function statusBadge(answer: DraftFieldAnswer | undefined): StatusBadgeMeta {
  if (!answer) return { text: "미입력", className: MUTED };
  switch (answer.status) {
    case "suggested": {
      if (answer.source === "profile" || answer.basis === "사업자 정보") {
        return { text: "자동 입력(사업자 정보)", className: SKY };
      }
      if (answer.source === "template") return { text: "자동 입력(양식 기본값) — 확인 필요", className: SKY };
      return { text: "제안 — 확인 필요", className: SKY };
    }
    case "accepted":
      return { text: "확정", className: EMERALD };
    case "edited":
      return { text: "확정(수정됨)", className: EMERALD };
    case "dismissed":
      return { text: "건너뜀", className: MUTED };
    default:
      return { text: "미입력", className: MUTED };
  }
}

export function FieldCard({
  field,
  answer,
  isDuplicate,
  isSelected,
  isPending,
  isSuggestable,
  isSuggesting,
  tips,
  onSelect,
  onAccept,
  onSave,
  onDismiss,
  onUndo,
  onAsk,
  onRequestSuggestion,
}: {
  field: ConnectedDocumentField;
  answer: DraftFieldAnswer | undefined;
  isDuplicate: boolean;
  isSelected: boolean;
  isPending: boolean;
  /** LLM 제안('제안 받기') 노출 대상인지(서버 판정 — 서술형·manual류 아님, P4). */
  isSuggestable: boolean;
  /** 이 필드의 제안 생성 요청이 진행 중인지(로딩 스피너). */
  isSuggesting: boolean;
  tips: FieldLessonTip[];
  onSelect: () => void;
  onAccept: () => void;
  onSave: (value: string) => void;
  onDismiss: () => void;
  onUndo: () => void;
  /** "이 항목이 뭐예요?" → 채팅 프리필(ADR-9). 미제공 시 버튼 비활성. */
  onAsk?: () => void;
  /** "제안 받기"/"다시 제안" → LLM 필드 제안(P4). 미제공 시 버튼 비노출. */
  onRequestSuggestion?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(answer?.value ?? "");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 선택되면 리스트에서 보이도록 스크롤(오버레이→카드 동기화).
  useEffect(() => {
    if (isSelected) {
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isSelected]);

  const status = answer?.status;
  const value = answer?.value ?? "";
  const hasValue = value.trim().length > 0;
  const canUndo = answer?.suggestedValue !== undefined && status !== "suggested";
  const badge = statusBadge(answer);
  const hasPosition = field.position != null;
  // '제안 받기'/'다시 제안'(P4): 서버가 제안 대상으로 판정한 서술형 필드에서 미확정(미입력·제안) 상태일 때만.
  // 확정(accepted/edited)·건너뜀(dismissed)에는 노출하지 않는다(컨펌 게이트 — 서버 병합도 그 상태를 보존).
  const canSuggest =
    Boolean(onRequestSuggestion) && isSuggestable && (status === undefined || status === "suggested");

  function startEditing() {
    setDraftValue(value);
    setEditing(true);
  }

  function commitEdit() {
    const next = draftValue.trim();
    if (!next) return;
    onSave(next);
    setEditing(false);
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "grid gap-2 rounded-[var(--radius-lg)] border bg-card p-3 transition-colors",
        isSelected ? "border-primary ring-1 ring-primary/40" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onSelect}
          aria-pressed={isSelected}
          className="h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 rounded-[var(--radius-md)] px-2 py-1 text-left font-normal"
        >
          <span className="block w-full truncate text-sm font-medium">{field.label}</span>
          {field.section ? (
            <span className="block w-full truncate text-xs text-muted-foreground">{field.section}</span>
          ) : null}
        </Button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {field.required ? <Badge variant="default">필수</Badge> : null}
          <Badge variant="outline" className={badge.className}>
            {badge.text}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {!hasPosition ? (
          <Badge variant="outline" className={cn("gap-1", MUTED)}>
            <MapPinOff className="size-3" aria-hidden />
            위치 미확인
          </Badge>
        ) : null}
        {isDuplicate ? (
          <Badge variant="outline" className={cn("gap-1", AMBER)}>
            <TriangleAlert className="size-3" aria-hidden />
            동일 항목명 — 수동 확인 필요
          </Badge>
        ) : null}
      </div>

      {editing ? (
        <div className="grid gap-2">
          <Textarea
            value={draftValue}
            onChange={(event) => setDraftValue(event.currentTarget.value)}
            aria-label={`${field.label} 값`}
            rows={2}
            autoFocus
          />
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" onClick={commitEdit} disabled={isPending || !draftValue.trim()}>
              <Check className="size-3.5" aria-hidden />
              저장
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={isPending}>
              취소
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={cn(
              "min-h-5 whitespace-pre-wrap break-words rounded-[var(--radius-md)] px-2 py-1.5 text-sm",
              hasValue
                ? status === "suggested"
                  ? "border border-dashed border-sky-500/50 bg-sky-500/[0.04] text-foreground"
                  : "bg-muted/40 text-foreground"
                : "text-muted-foreground",
            )}
          >
            {hasValue ? value : "미입력"}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {status === "suggested" && hasValue ? (
              <Button type="button" size="sm" onClick={onAccept} disabled={isPending || isSuggesting}>
                {isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                반영
              </Button>
            ) : null}
            {canSuggest ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant={hasValue ? "outline" : "default"}
                      onClick={onRequestSuggestion}
                      disabled={isPending || isSuggesting}
                    />
                  }
                >
                  {isSuggesting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-3.5" aria-hidden />
                  )}
                  {hasValue ? "다시 제안" : "제안 받기"}
                </TooltipTrigger>
                <TooltipContent>{hasValue ? "AI 제안을 다시 받기" : "AI가 작성 값을 제안"}</TooltipContent>
              </Tooltip>
            ) : null}
            <Button type="button" size="sm" variant="secondary" onClick={startEditing} disabled={isPending || isSuggesting}>
              <Pencil className="size-3.5" aria-hidden />
              {hasValue ? "수정" : "값 입력"}
            </Button>
            {status !== "dismissed" ? (
              <Button type="button" size="sm" variant="outline" onClick={onDismiss} disabled={isPending}>
                <SkipForward className="size-3.5" aria-hidden />
                건너뛰기
              </Button>
            ) : null}
            {canUndo ? (
              <Button type="button" size="sm" variant="ghost" onClick={onUndo} disabled={isPending}>
                <RotateCcw className="size-3.5" aria-hidden />
                되돌리기
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={onAsk}
                    disabled={!onAsk || isPending}
                    className="text-muted-foreground"
                  />
                }
              >
                <HelpCircle className="size-3.5" aria-hidden />
                이 항목이 뭐예요?
              </TooltipTrigger>
              <TooltipContent>{onAsk ? "채팅으로 이 항목 설명 받기" : "채팅 준비 중"}</TooltipContent>
            </Tooltip>
          </div>
        </>
      )}

      {tips.length > 0 ? <FieldLessonTips tips={tips} /> : null}
    </div>
  );
}
