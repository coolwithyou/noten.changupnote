"use client";

import { useEffect, useState } from "react";
import {
  Check,
  HelpCircle,
  Loader2,
  MapPinOff,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SkipForward,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { FieldLessonTips } from "@/features/knowledge/FieldLessonTips";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswer } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";
import { workspaceFieldState } from "./workspacePresentation";

const STATUS_META = {
  filled: { label: "확인 완료", className: "border-success/40 bg-success-soft text-success" },
  reviewing: { label: "확인 중", className: "border-primary/40 bg-primary/10 text-primary" },
  empty: { label: "미입력", className: "border-border bg-muted text-muted-foreground" },
} as const;

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
  const status = STATUS_META[state];
  const [editing, setEditing] = useState(isSelected && !hasValue);
  const [draftValue, setDraftValue] = useState(value);
  const canSuggest = isSuggestable && (answer?.status === undefined || answer.status === "suggested");
  const canUndo = answer?.suggestedValue !== undefined && answer.status !== "suggested";

  useEffect(() => {
    setDraftValue(value);
    setEditing(isSelected && !value.trim() && answer?.status !== "dismissed");
  }, [field.fieldId, isSelected, value, answer?.status]);

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
        <CardTitle className="text-xl">{field.label}</CardTitle>
        <CardDescription>
          {field.section ? `${field.section}에 들어갈 내용을 확인해 주세요.` : "공고 양식에 들어갈 내용을 확인해 주세요."}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {field.required ? <Badge>필수</Badge> : null}
          <Badge variant="outline" className={status.className}>{status.label}</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" size="icon-sm" variant="ghost" aria-label={`${field.label} 추가 작업`} />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canSuggest ? (
                <DropdownMenuItem onClick={onRequestSuggestion} disabled={isPending || isSuggesting}>
                  {isSuggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  {hasValue ? "초안 다시 제안받기" : "초안 제안받기"}
                </DropdownMenuItem>
              ) : null}
              {canUndo ? (
                <DropdownMenuItem onClick={onUndo} disabled={isPending}>
                  <RotateCcw />
                  제안 값으로 되돌리기
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {!field.position ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <MapPinOff />
              위치 미확인
            </Badge>
          ) : null}
          {isDuplicate ? (
            <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
              <TriangleAlert />
              동일 항목명 — 수동 확인 필요
            </Badge>
          ) : null}
        </div>

        {editing ? (
          <Textarea
            value={draftValue}
            onChange={(event) => setDraftValue(event.currentTarget.value)}
            aria-label={`${field.label} 값`}
            placeholder={`${field.label}을(를) 입력해 주세요.`}
            rows={4}
            autoFocus
          />
        ) : (
          <div className={state === "reviewing" ? "rounded-[var(--radius-lg)] bg-primary/10 p-4" : "rounded-[var(--radius-lg)] bg-muted/50 p-4"}>
            <p className={hasValue ? "whitespace-pre-wrap break-words text-base font-semibold" : "text-sm text-muted-foreground"}>
              {hasValue ? value : "아직 입력된 값이 없습니다."}
            </p>
            {answer?.basis ? <p className="mt-2 text-xs text-muted-foreground">{answer.basis} 기준</p> : null}
          </div>
        )}

        {tips.length > 0 ? <FieldLessonTips tips={tips} /> : null}
        {primaryAction}

        <div className="flex items-center justify-center gap-1">
          {editing && canSuggest ? (
            <Button type="button" size="sm" variant="link" onClick={onRequestSuggestion} disabled={isPending || isSuggesting}>
              {isSuggesting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : <Sparkles data-icon="inline-start" aria-hidden />}
              초안 제안받기
            </Button>
          ) : editing ? (
            <Button type="button" size="sm" variant="link" onClick={() => setEditing(false)} disabled={isPending}>
              입력 취소
            </Button>
          ) : (
            <Button type="button" size="sm" variant="link" onClick={startEditing} disabled={isPending}>
              직접 수정
            </Button>
          )}
          <Button type="button" size="sm" variant="link" onClick={onDismiss} disabled={isPending || answer?.status === "dismissed"}>
            <SkipForward data-icon="inline-start" aria-hidden />
            건너뛰기
          </Button>
        </div>
      </CardContent>

      <CardFooter className="justify-center bg-card">
        <Button type="button" size="sm" variant="ghost" onClick={onAsk} className="text-muted-foreground">
          <HelpCircle data-icon="inline-start" aria-hidden />
          이 항목이 궁금하면 물어보세요
        </Button>
      </CardFooter>
    </Card>
  );
}
