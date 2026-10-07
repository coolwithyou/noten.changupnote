"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ActionResult,
  GrantConfirmationQuestionDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import {
  confirmationResponseIsCurrent,
  type ConfirmationRequestScope,
} from "./confirmationRequestScope";
import {
  inlineConfirmationEndpoint,
  inlineConfirmationOutcome,
  selectInlineConfirmationQuestion,
  type InlineQuestionState,
} from "./inlineConfirmationLogic";

export function InlineGrantConfirmation({
  companyId,
  grantId,
  questionId,
  onSaved,
  onPrepare,
  onFallback,
}: {
  companyId: string;
  grantId: string;
  questionId: string;
  onSaved: (result: GrantConfirmationSubmitResult) => void;
  onPrepare: (grantId: string) => void;
  onFallback: () => void;
}) {
  const endpoint = inlineConfirmationEndpoint(grantId, companyId);
  const scopeRef = useRef<ConfirmationRequestScope & { key: string }>({
    endpoint,
    generation: 0,
    key: "",
  });
  const resultRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${endpoint}:${questionId}`;
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = {
      endpoint,
      generation: scopeRef.current.generation + 1,
      key: scopeKey,
    };
  }
  const [reloadKey, setReloadKey] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable" | "error" | "saved">("loading");
  const [selected, setSelected] = useState<InlineQuestionState | null>(null);
  const [savedResult, setSavedResult] = useState<GrantConfirmationSubmitResult | null>(null);
  const [submittingValue, setSubmittingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const requestScope = { ...scopeRef.current };
    setLoadState("loading");
    setSelected(null);
    setSavedResult(null);
    setSubmittingValue(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
        const payload = await response.json() as ActionResult<GrantConfirmationsResult>;
        if (cancelled || !confirmationResponseIsCurrent({
          request: requestScope,
          current: scopeRef.current,
          open: true,
        })) return;
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "확인 질문을 불러오지 못했어요.");
        }
        const next = selectInlineConfirmationQuestion(payload.data, questionId);
        setSelected(next);
        setLoadState(next.status === "ready" ? "ready" : "unavailable");
      } catch (caught) {
        if (cancelled || !confirmationResponseIsCurrent({
          request: requestScope,
          current: scopeRef.current,
          open: true,
        })) return;
        setError(caught instanceof Error ? caught.message : "확인 질문을 불러오지 못했어요.");
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
      if (scopeRef.current.generation === requestScope.generation) {
        scopeRef.current = { ...scopeRef.current, generation: scopeRef.current.generation + 1 };
      }
    };
  }, [endpoint, questionId, reloadKey]);

  async function submit(
    question: GrantConfirmationQuestionDto,
    answerRevision: number,
    companyFactRevision: string | null,
    value: string,
  ) {
    if (submittingValue) return;
    const requestScope = { ...scopeRef.current };
    setSubmittingValue(value);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: [{
            questionId: question.id,
            values: [value],
            binding: question.binding,
            expectedAnswerRevision: answerRevision,
            expectedCompanyFactRevision: companyFactRevision,
          }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json() as ActionResult<GrantConfirmationSubmitResult>;
      if (!confirmationResponseIsCurrent({
        request: requestScope,
        current: scopeRef.current,
        open: true,
      })) return;
      if (response.status === 401 || response.status === 403) {
        setLoadState("unavailable");
        setSelected({ status: "unavailable", reason: "readonly" });
        return;
      }
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "확인 답변을 저장하지 못했어요.");
      }
      setLoadState("saved");
      setSelected(null);
      setSavedResult(payload.data);
    } catch (caught) {
      if (!confirmationResponseIsCurrent({
        request: requestScope,
        current: scopeRef.current,
        open: true,
      })) return;
      setError(caught instanceof Error ? caught.message : "확인 답변을 저장하지 못했어요.");
    } finally {
      if (confirmationResponseIsCurrent({
        request: requestScope,
        current: scopeRef.current,
        open: true,
      })) setSubmittingValue(null);
    }
  }

  const savedOutcome = savedResult ? inlineConfirmationOutcome(savedResult) : null;

  useEffect(() => {
    if (loadState === "saved") resultRef.current?.focus();
  }, [loadState]);

  function continueFromSavedResult() {
    if (!savedResult || !savedOutcome) return;
    onSaved(savedResult);
    if (savedOutcome.action === "prepare") onPrepare(grantId);
  }

  return (
    <section className="mt-4 rounded-2xl border border-brand-tint bg-surface-brand px-4 py-4 sm:px-5">
      <p className="text-xs font-extrabold text-brand">이 조건 하나만 확인하면 돼요</p>
      {loadState === "loading" ? (
        <p className="mt-2 text-sm text-text-secondary" aria-live="polite">확인 질문을 불러오고 있어요…</p>
      ) : null}
      {loadState === "ready" && selected?.status === "ready" ? (
        <>
          <h4 className="mt-2 text-[16px] leading-6 font-extrabold text-ink">{selected.question.prompt}</h4>
          <p className="mt-1 text-[13px] leading-5 text-text-secondary">
            답하면 이 공고의 지원 가능 여부를 바로 다시 확인해요.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {selected.question.options.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={option.isUnknown ? "outline" : "default"}
                disabled={submittingValue !== null}
                onClick={() => void submit(
                  selected.question,
                  selected.answerRevision,
                  selected.companyFactRevision,
                  option.value,
                )}
                className="min-h-11 whitespace-normal sm:min-w-28"
              >
                {submittingValue === option.value ? "확인 중…" : option.label}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {loadState === "unavailable" ? (
        <div className="mt-2">
          <p className="text-sm leading-6 text-text-secondary">
            질문의 최신 내용을 확인한 뒤 답할 수 있어요.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onFallback} className="mt-2">
            확인 내용 보기
          </Button>
        </div>
      ) : null}
      {loadState === "saved" && savedResult && savedOutcome ? (
        <div ref={resultRef} tabIndex={-1} className="mt-2 focus:outline-none" aria-live="polite">
          <p className="text-sm font-extrabold text-brand">
            {savedOutcome.title}
          </p>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {savedOutcome.detail}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={continueFromSavedResult}
            className="mt-3"
          >
            {savedOutcome.actionLabel}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3" aria-live="polite">
          <p className="text-sm text-destructive">{error}</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey((current) => current + 1)}>
              다시 불러오기
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onFallback}>
              확인 화면 열기
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
