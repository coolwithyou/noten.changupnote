"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type {
  ActionResult,
  GrantConfirmationQuestionDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type LoadStatus = "loading" | "ready" | "error";

/**
 * 공고별 자가신고 확인 시트(확인 루프 Phase B) — DisqualificationSheet/PriorAwardSheet 패턴.
 * 질문은 중립 제시(선택지에 결격 여부 표기 없음 — 유도 방지)하고, 미선택 건너뛰기를 허용한다
 * (미답변=미해소 유지). 저장 성공 시 재계산 카드를 onSaved 로 올려 4상태 버킷 이동을 반영한다.
 */
export function ConfirmationSheet({
  grantId,
  grantTitle,
  open,
  onOpenChange,
  onSaved,
}: {
  grantId: string;
  grantTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (result: GrantConfirmationSubmitResult) => void;
}) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [questions, setQuestions] = useState<GrantConfirmationQuestionDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    (async () => {
      try {
        const response = await fetch(
          `/api/web/matches/${encodeURIComponent(grantId)}/confirmations`,
          { signal: AbortSignal.timeout(15_000) },
        );
        const payload = (await response.json()) as ActionResult<GrantConfirmationsResult>;
        if (cancelled) return;
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "확인 질문을 불러오지 못했습니다.");
        }
        setQuestions(payload.data.questions);
        // 기존 답변을 초기 선택으로 복원한다(재확인·답변 수정 진입점).
        setDraft(Object.fromEntries(
          payload.data.answers.map((answer) => [answer.questionId, answer.values]),
        ));
        setStatus("ready");
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "확인 질문을 불러오지 못했습니다.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, grantId, reloadKey]);

  function setAnswer(question: GrantConfirmationQuestionDto, next: string[]) {
    const optionValues = new Set(question.options.map((option) => option.value));
    const values = next.filter((value) => optionValues.has(value));
    setDraft((current) => ({
      ...current,
      // single 은 마지막 선택 1개만 유지(재선택 시 교체), 전부 해제하면 미답변으로 되돌린다.
      [question.id]: question.answerType === "single" ? values.slice(-1) : values,
    }));
  }

  const answeredEntries = questions
    .map((question) => ({ questionId: question.id, values: draft[question.id] ?? [] }))
    .filter((entry) => entry.values.length > 0);

  async function save() {
    if (submitting || answeredEntries.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/web/matches/${encodeURIComponent(grantId)}/confirmations`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: answeredEntries }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      const payload = (await response.json()) as ActionResult<GrantConfirmationSubmitResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "확인 답변을 저장하지 못했습니다.");
      }
      onSaved?.(payload.data);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "확인 답변을 저장하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-[420px] gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]"
      >
        <SheetHeader className="flex-row items-center justify-between px-6 pt-6 pb-0">
          <div>
            <SheetTitle className="text-lg font-extrabold">공고 확인 질문</SheetTitle>
            <SheetDescription className="sr-only">
              공고 조건 중 회사가 직접 확인해야 하는 항목을 자가신고 기준으로 답합니다.
            </SheetDescription>
          </div>
          <SheetClose
            render={<Button type="button" variant="ghost" size="icon-sm" aria-label="공고 확인 질문 닫기" />}
          >
            <X aria-hidden />
          </SheetClose>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 pt-4 pb-6">
            <p className="break-words text-[13px] font-bold text-text-nav">{grantTitle}</p>
            <div className="mt-3 rounded-[14px] bg-surface-soft px-4 py-3.5">
              <p className="text-[13.5px] leading-relaxed text-text-nav">
                공고 조건 중 회사가 직접 확인해야 하는 항목이에요. 답한 내용은 판정에 바로 반영돼요.
              </p>
              <p className="mt-1.5 text-[11.5px] text-text-tertiary">
                자가신고 기준이에요 · 잘 모르는 질문은 건너뛰어도 돼요
              </p>
            </div>

            {status === "loading" ? (
              <div className="mt-4 flex flex-col gap-4">
                <Skeleton className="h-16 w-full rounded-[14px]" />
                <Skeleton className="h-16 w-full rounded-[14px]" />
                <Skeleton className="h-16 w-full rounded-[14px]" />
              </div>
            ) : null}

            {status === "error" ? (
              <div className="mt-4 flex flex-col items-start gap-2">
                <p className="text-sm text-destructive" aria-live="polite">{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                  다시 불러오기
                </Button>
              </div>
            ) : null}

            {status === "ready" && questions.length === 0 ? (
              <p className="mt-4 rounded-xl bg-surface-soft px-4 py-3 text-sm leading-6 text-text-secondary">
                이 공고는 확인할 질문이 없어요.
              </p>
            ) : null}

            {status === "ready" && questions.length > 0 ? (
              <div className="mt-4 flex flex-col gap-4">
                {questions.map((question) => (
                  <div key={question.id}>
                    <p className="text-sm font-semibold text-ink">{question.prompt}</p>
                    <ToggleGroup
                      aria-label={question.prompt}
                      className="mt-2 w-fit flex-wrap"
                      variant="outline"
                      spacing={1}
                      {...(question.answerType === "multi" ? { toggleMultiple: true } : {})}
                      value={draft[question.id] ?? []}
                      onValueChange={(next) => {
                        setAnswer(question, next.filter((value): value is string => typeof value === "string"));
                      }}
                    >
                      {question.options.map((option) => (
                        <ToggleGroupItem key={option.value} value={option.value} disabled={submitting}>
                          {option.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                ))}
                {error ? (
                  <p className="text-xs text-destructive" aria-live="polite">{error}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {status === "ready" && questions.length > 0 ? (
          <SheetFooter className="gap-2 border-t border-border-subtle px-6 py-4">
            <Button
              type="button"
              className="w-full"
              onClick={() => void save()}
              disabled={submitting || answeredEntries.length === 0}
            >
              {submitting ? "저장 중" : "저장"}
            </Button>
            <p className="text-center text-[12px] text-text-tertiary">
              자가신고 기준이에요 · 확인한 만큼 판정이 정확해져요
            </p>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
