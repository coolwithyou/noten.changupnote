"use client";

/**
 * 필드 확인 카드 (Apply Experience v2 · 재정의 §2-② 7슬롯 구조).
 *
 * 위→아래 고정 슬롯: ⑴ 상단 라벨(확인이 필요한 항목 N개 중 M번째) ⑵ 필드명 + 위치 캡션
 * ⑶ 설명 한 줄 ⑷ 값 박스(A 자동값 확인) 또는 변형 B(직접 입력 + 힌트 + 초안 제안 받기 링크)
 * ⑸ 주 CTA 1개 ⑹ 보조 링크 2개(직접 수정·건너뛰기 / 편집 중엔 되돌리기·입력 취소)
 * ⑺ 하단 💬 이 항목이 궁금하면 물어보세요.
 *
 * 뱃지(필수·상태·위치 미확인·팁 tier)와 ⋯ 드롭다운은 재정의로 제거됐다. 상태는 값 박스와
 * 상단 진행 표시가 말한다. 중복 label 만 카드 본문 경고 한 줄(Alert)로 유지한다.
 */
import { useEffect, useRef, useState } from "react";
import { Check, HelpCircle, Loader2, Pencil, SkipForward, Sparkles, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswer } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";
import { fieldDescriptionLine, fieldPositionCaption, workspaceFieldState } from "./workspacePresentation";

export function FieldCard({
  field,
  answer,
  reviewPosition,
  reviewTotal,
  isDuplicate,
  isSelected,
  isPending,
  isSuggestable,
  isSuggesting,
  tips,
  onAccept,
  onSave,
  onDismiss,
  onUndo,
  onAsk,
  onNext,
  onRequestSuggestion,
}: {
  field: ConnectedDocumentField;
  answer: DraftFieldAnswer | undefined;
  /** 확인이 필요한(미완료) 항목 내 순번(1-base). 이 카드가 이미 확인 완료면 0. */
  reviewPosition: number;
  /** 확인이 필요한(미완료) 항목 수. */
  reviewTotal: number;
  isDuplicate: boolean;
  isSelected: boolean;
  isPending: boolean;
  isSuggestable: boolean;
  isSuggesting: boolean;
  tips: FieldLessonTip[];
  onAccept: () => void;
  onSave: (value: string) => void;
  onDismiss: () => void;
  onUndo: () => void;
  onAsk: () => void;
  onNext: () => void;
  onRequestSuggestion: () => void;
}) {
  const value = answer?.value ?? "";
  const hasValue = value.trim().length > 0;
  const state = workspaceFieldState(answer);
  const [editing, setEditing] = useState(isSelected && !hasValue);
  const [draftValue, setDraftValue] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSuggest = isSuggestable && (answer?.status === undefined || answer.status === "suggested");
  const canUndo = answer?.suggestedValue !== undefined && answer.status !== "suggested";

  const positionCaption = fieldPositionCaption(field.position, field.section);
  const descriptionLine = fieldDescriptionLine(field, tips);

  useEffect(() => {
    setDraftValue(value);
    setEditing(isSelected && !value.trim() && answer?.status !== "dismissed");
  }, [field.fieldId, isSelected, value, answer?.status]);

  function startEditing() {
    setDraftValue(value);
    setEditing(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function commitEdit() {
    const next = draftValue.trim();
    if (!next) return;
    onSave(next);
    setEditing(false);
  }

  // ⑸ 주 CTA 1개 — 상태별 하나.
  const primaryAction = (() => {
    if (editing) {
      return (
        <Button type="button" className="w-full" onClick={commitEdit} disabled={isPending || !draftValue.trim()}>
          {isPending ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Check data-icon="inline-start" aria-hidden />}
          입력 완료
        </Button>
      );
    }
    if (answer?.status === "suggested" && hasValue) {
      return (
        <Button type="button" className="w-full" onClick={onAccept} disabled={isPending || isSuggesting}>
          {isPending ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Check data-icon="inline-start" aria-hidden />}
          이 값으로 채우기
        </Button>
      );
    }
    if (state === "filled") {
      return (
        <Button type="button" className="w-full" onClick={onNext}>
          다음 항목 확인하기
        </Button>
      );
    }
    return (
      <Button type="button" className="w-full" onClick={startEditing} disabled={isPending}>
        <Pencil data-icon="inline-start" aria-hidden />
        직접 입력하기
      </Button>
    );
  })();

  return (
    <Card className="shadow-[var(--shadow-subtle)]">
      <CardHeader>
        {/* ⑴ 상단 라벨 */}
        <div className="text-xs font-semibold text-muted-foreground">
          {reviewPosition > 0 && reviewTotal > 0 ? (
            <>
              확인이 필요한 항목 {reviewTotal.toLocaleString("ko-KR")}개 중{" "}
              <span className="text-primary">{reviewPosition.toLocaleString("ko-KR")}번째</span>
            </>
          ) : reviewTotal > 0 ? (
            <>확인 완료 · 확인이 필요한 항목 {reviewTotal.toLocaleString("ko-KR")}개 남음</>
          ) : (
            <>모든 항목을 확인했어요</>
          )}
        </div>
        {/* ⑵ 필드명 + 위치 캡션 */}
        <CardTitle className="text-xl">{field.label}</CardTitle>
        {positionCaption ? (
          <p className="text-xs text-muted-foreground">{positionCaption}</p>
        ) : null}
        {/* ⑶ 설명 한 줄 */}
        {descriptionLine ? <CardDescription>{descriptionLine}</CardDescription> : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isDuplicate ? (
          <Alert className="border-warning-strong/40 text-warning-strong *:data-[slot=alert-description]:text-warning-strong">
            <TriangleAlert />
            <AlertDescription>동일 항목명이 여러 칸에 있어 자동 채움에서 제외돼요. 직접 확인해 주세요.</AlertDescription>
          </Alert>
        ) : null}

        {/* ⑷ 값 박스(A) 또는 변형 B(직접 입력) */}
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              ref={textareaRef}
              value={draftValue}
              onChange={(event) => setDraftValue(event.currentTarget.value)}
              aria-label={`${field.label} 값`}
              placeholder={`${field.label}을(를) 입력해 주세요.`}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">공고 기준에 맞게 자유롭게 입력하세요. 저장 전까지 반영되지 않아요.</p>
            {canSuggest ? (
              <Button
                type="button"
                size="sm"
                variant="link"
                className="self-start px-0"
                onClick={onRequestSuggestion}
                disabled={isPending || isSuggesting}
              >
                {isSuggesting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Sparkles data-icon="inline-start" aria-hidden />}
                초안 제안 받기
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={state === "reviewing" ? "rounded-[var(--radius-lg)] bg-primary/10 p-4" : "rounded-[var(--radius-lg)] bg-muted/50 p-4"}>
            <p className={hasValue ? "whitespace-pre-wrap break-words text-base font-semibold" : "text-sm text-muted-foreground"}>
              {hasValue ? value : "아직 입력된 값이 없습니다."}
            </p>
            {answer?.basis ? <p className="mt-2 text-xs text-muted-foreground">{answer.basis} 기준</p> : null}
          </div>
        )}

        {primaryAction}

        {/* ⑹ 보조 링크 2개 */}
        <div className="flex items-center justify-center gap-1">
          {editing ? (
            <>
              {canUndo ? (
                <Button type="button" size="sm" variant="link" onClick={onUndo} disabled={isPending}>
                  제안 값으로 되돌리기
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="link" onClick={() => setEditing(false)} disabled={isPending}>
                입력 취소
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="link" onClick={startEditing} disabled={isPending}>
                직접 수정
              </Button>
              <Button type="button" size="sm" variant="link" onClick={onDismiss} disabled={isPending || answer?.status === "dismissed"}>
                <SkipForward data-icon="inline-start" aria-hidden />
                건너뛰기
              </Button>
            </>
          )}
        </div>
      </CardContent>

      {/* ⑺ 하단 채팅 진입 */}
      <CardFooter className="justify-center bg-card">
        <Button type="button" size="sm" variant="ghost" onClick={onAsk} className="text-muted-foreground">
          <HelpCircle data-icon="inline-start" aria-hidden />
          이 항목이 궁금하면 물어보세요
        </Button>
      </CardFooter>
    </Card>
  );
}
