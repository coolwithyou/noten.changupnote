"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  ActionResult,
  GrantConfirmationQuestionDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
} from "@cunote/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  confirmationResponseIsCurrent,
  confirmationSubmissionIsAllowed,
  invalidateConfirmationRequestScope,
  type ConfirmationRequestScope,
} from "./confirmationRequestScope";

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
  companyId = null,
}: {
  grantId: string;
  grantTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (result: GrantConfirmationSubmitResult) => void;
  companyId?: string | null;
}) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [questions, setQuestions] = useState<GrantConfirmationQuestionDto[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [persistedDraft, setPersistedDraft] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [permissionChanged, setPermissionChanged] = useState(false);
  const [loadedScope, setLoadedScope] = useState<ConfirmationRequestScope | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const endpoint = `/api/web/matches/${encodeURIComponent(grantId)}/confirmations${companyId ? `?${new URLSearchParams({ companyId })}` : ""}`;
  const requestScopeRef = useRef<ConfirmationRequestScope & { key: string }>({
    endpoint,
    generation: 0,
    key: "",
  });
  const scopeKey = `${open ? "open" : "closed"}:${endpoint}:${reloadKey}`;
  if (requestScopeRef.current.key !== scopeKey) {
    requestScopeRef.current = {
      endpoint,
      generation: requestScopeRef.current.generation + 1,
      key: scopeKey,
    };
  }
  const [answerRevisionByQuestion, setAnswerRevisionByQuestion] = useState<Record<string, number>>({});
  const loadedResponseIsCurrent = loadedScope !== null && confirmationResponseIsCurrent({
    request: loadedScope,
    current: requestScopeRef.current,
    open,
  });
  const effectiveStatus: LoadStatus = loadedResponseIsCurrent ? status : "loading";
  const submissionAllowed = confirmationSubmissionIsAllowed({
    loaded: loadedScope,
    current: requestScopeRef.current,
    open,
    status,
    canSubmit,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const requestScope = { ...requestScopeRef.current };
    setStatus("loading");
    setSubmitting(false);
    setError(null);
    setCanSubmit(false);
    setPermissionChanged(false);
    setLoadedScope(null);
    (async () => {
      try {
        const response = await fetch(
          endpoint,
          { signal: AbortSignal.timeout(15_000) },
        );
        const payload = (await response.json()) as ActionResult<GrantConfirmationsResult>;
        if (cancelled || !confirmationResponseIsCurrent({
          request: requestScope,
          current: requestScopeRef.current,
          open,
        })) return;
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "확인 질문을 불러오지 못했습니다.");
        }
        setQuestions(payload.data.questions);
        // 기존 답변을 초기 선택으로 복원한다(재확인·답변 수정 진입점).
        const loadedDraft = Object.fromEntries(
          payload.data.answers.map((answer) => [answer.questionId, answer.values]),
        );
        setDraft(loadedDraft);
        setPersistedDraft(loadedDraft);
        setAnswerRevisionByQuestion(Object.fromEntries(
          payload.data.answers.map((answer) => [answer.questionId, answer.answerRevision ?? 0]),
        ));
        setCanSubmit(payload.data.canSubmit === true);
        setLoadedScope(requestScope);
        setStatus("ready");
      } catch (caught) {
        if (cancelled || !confirmationResponseIsCurrent({
          request: requestScope,
          current: requestScopeRef.current,
          open,
        })) return;
        setCanSubmit(false);
        setLoadedScope(requestScope);
        setError(caught instanceof Error ? caught.message : "확인 질문을 불러오지 못했습니다.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      // dependency 교체 뒤에는 render가 이미 새 세대를 만들었다. unmount처럼 아직 같은
      // 세대일 때만 한 번 더 무효화해 pending PUT closure도 onSaved를 호출하지 못하게 한다.
      if (requestScopeRef.current.generation === requestScope.generation) {
        requestScopeRef.current = invalidateConfirmationRequestScope({
          request: requestScope,
          current: requestScopeRef.current,
        });
      }
    };
  }, [open, endpoint, reloadKey]);

  function setAnswer(question: GrantConfirmationQuestionDto, next: string[]) {
    if (!confirmationSubmissionIsAllowed({
      loaded: loadedScope,
      current: requestScopeRef.current,
      open,
      status,
      canSubmit,
    })) return;
    const optionValues = new Set(question.options.map((option) => option.value));
    const values = next.filter((value) => optionValues.has(value));
    const unknownValue = question.options.find((option) => option.isUnknown)?.value;
    setDraft((current) => ({
      ...current,
      // 저장된 값을 모두 해제하는 행위는 삭제가 아니다. v2는 명시적 '확인할 수 없음'으로
      // 바꾸고, legacy에는 기존 미답변/답변 보존 관례를 유지한다.
      [question.id]: question.answerType === "single"
        ? (values.length > 0 ? values.slice(-1) : unknownValue ? [unknownValue] : [])
        : values,
    }));
  }

  const answeredEntries = questions
    .map((question) => ({
      questionId: question.id,
      values: draft[question.id] ?? [],
      ...(question.binding ? {
        binding: question.binding,
        expectedAnswerRevision: answerRevisionByQuestion[question.id] ?? 0,
      } : {}),
    }))
    .filter((entry) => entry.values.length > 0);

  async function save() {
    if (!confirmationSubmissionIsAllowed({
      loaded: loadedScope,
      current: requestScopeRef.current,
      open,
      status,
      canSubmit,
    }) || submitting || answeredEntries.length === 0) return;
    setSubmitting(true);
    setError(null);
    const requestScope = { ...requestScopeRef.current };
    try {
      const response = await fetch(
        endpoint,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: answeredEntries }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      const payload = (await response.json()) as ActionResult<GrantConfirmationSubmitResult>;
      if (response.status === 401 || response.status === 403) {
        if (!confirmationResponseIsCurrent({
          request: requestScope,
          current: requestScopeRef.current,
          open,
        })) return;
        setDraft(persistedDraft);
        setCanSubmit(false);
        setPermissionChanged(true);
        return;
      }
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "확인 답변을 저장하지 못했습니다.");
      }
      if (!confirmationResponseIsCurrent({
        request: requestScope,
        current: requestScopeRef.current,
        open,
      })) return;
      onSaved?.(payload.data);
      onOpenChange(false);
    } catch (caught) {
      if (!confirmationResponseIsCurrent({
        request: requestScope,
        current: requestScopeRef.current,
        open,
      })) return;
      setError(caught instanceof Error ? caught.message : "확인 답변을 저장하지 못했습니다.");
    } finally {
      if (confirmationResponseIsCurrent({
        request: requestScope,
        current: requestScopeRef.current,
        open,
      })) setSubmitting(false);
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

            {effectiveStatus === "loading" ? (
              <div className="mt-4 flex flex-col gap-4">
                <Skeleton className="h-16 w-full rounded-[14px]" />
                <Skeleton className="h-16 w-full rounded-[14px]" />
                <Skeleton className="h-16 w-full rounded-[14px]" />
              </div>
            ) : null}

            {effectiveStatus === "error" ? (
              <div className="mt-4 flex flex-col items-start gap-2">
                <p className="text-sm text-destructive" aria-live="polite">{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                  다시 불러오기
                </Button>
              </div>
            ) : null}

            {effectiveStatus === "ready" && questions.length === 0 ? (
              <p className="mt-4 rounded-xl bg-surface-soft px-4 py-3 text-sm leading-6 text-text-secondary">
                이 공고는 확인할 질문이 없어요.
              </p>
            ) : null}

            {effectiveStatus === "ready" && questions.length > 0 ? (
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
                        <ToggleGroupItem key={option.value} value={option.value} disabled={submitting || !submissionAllowed}>
                          {option.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                ))}
                {error ? (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-destructive" aria-live="polite">{error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReloadKey((key) => key + 1)}
                    >
                      다시 불러오기
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {effectiveStatus === "ready" && questions.length > 0 ? (
          <SheetFooter className="gap-2 border-t border-border-subtle px-6 py-4">
            {submissionAllowed ? (
              <>
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
              </>
            ) : (
              <Alert>
                <AlertDescription>
                  {permissionChanged
                    ? "회사 접근 권한이 변경되어 변경 내용은 저장되지 않았어요. 저장된 답변과 현재 권한을 다시 확인해 주세요."
                    : "조회 전용 권한이에요. 질문과 기존 답변은 볼 수 있지만 변경할 수 없어요."}
                </AlertDescription>
                {permissionChanged ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                    권한 다시 확인
                  </Button>
                ) : null}
              </Alert>
            )}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
