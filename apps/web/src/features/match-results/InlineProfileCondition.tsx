"use client";

import { useState } from "react";
import type { MatchingProfileAnswerRequest, NextQuestionDto } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import {
  parseQuestionValue,
  shouldMergeQuestionValue,
} from "@/features/profile-questions/questionAnswer";
import { TeaserQuestionForm } from "./TeaserQuestionForm";

export function InlineProfileCondition({
  question,
  requirement,
  onAnswer,
  submitting,
}: {
  question: NextQuestionDto;
  requirement: string;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
}) {
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = inlineProfileOptions(question, requirement);

  async function answer(value: string) {
    if (submitting || pendingValue) return;
    setPendingValue(value);
    setError(null);
    try {
      await onAnswer({
        field: question.dimension,
        value: parseQuestionValue(question, value),
        ...(shouldMergeQuestionValue(question, value) ? { mode: "merge" as const } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "회사 정보를 반영하지 못했어요.");
    } finally {
      setPendingValue(null);
    }
  }

  async function answerUnknown() {
    if (submitting || pendingValue) return;
    setPendingValue("__unknown__");
    setError(null);
    try {
      await onAnswer({ field: question.dimension, unknown: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "회사 정보를 반영하지 못했어요.");
    } finally {
      setPendingValue(null);
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-brand-tint bg-surface-brand px-3.5 py-3.5 sm:px-4">
      <p className="text-xs font-extrabold text-brand">이 공고에서 바로 확인</p>
      <h4 className="mt-1.5 text-[15px] leading-6 font-extrabold text-ink">
        {inlineProfilePrompt(question)}
      </h4>
      <p className="mt-1 text-[13px] leading-5 text-text-secondary">
        답변하면 이 공고와 관련된 {question.affectedGrantCount.toLocaleString("ko-KR")}개 공고를 함께 다시 확인해요.
      </p>
      {question.inputType === "select" && options.length > 0 ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant="outline"
                disabled={submitting || pendingValue !== null}
                onClick={() => void answer(option)}
                className="min-h-10 rounded-full border-brand-tint bg-card px-4 text-sm text-ink hover:border-brand hover:bg-surface-brand"
              >
                {pendingValue === option ? "반영 중…" : option}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={submitting || pendingValue !== null}
            onClick={() => void answerUnknown()}
            className="mt-2 h-auto px-0 text-xs text-text-secondary"
          >
            {pendingValue === "__unknown__" ? "반영 중…" : "잘 모르겠어요"}
          </Button>
        </>
      ) : (
        <div className="mt-3">
          <TeaserQuestionForm
            question={question}
            onAnswer={onAnswer}
            submitting={submitting}
            variant={question.inputType === "boolean" ? "spotlight" : "default"}
          />
        </div>
      )}
      {error ? <p className="mt-2 text-sm text-destructive" aria-live="polite">{error}</p> : null}
    </section>
  );
}

export function inlineProfileOptions(question: NextQuestionDto, requirement: string): string[] {
  if (question.inputType !== "select" || !question.options?.length) return [];
  const tokens = new Set(
    requirement
      .normalize("NFKC")
      .split(/[,/\n·]|\s+(?:및|또는)\s+/u)
      .map((value) => value.replace(/[()]/gu, "").trim())
      .filter(Boolean),
  );
  const matched = question.options.filter((option) => tokens.has(option.normalize("NFKC").trim()));
  return (matched.length > 0 ? matched : question.options).slice(0, 8);
}

function inlineProfilePrompt(question: NextQuestionDto): string {
  if (question.dimension === "target_type") return "우리 회사에 해당하는 신청 대상을 선택해 주세요.";
  if (question.dimension === "region") return "지원 가능한 회사 소재지를 선택해 주세요.";
  return question.prompt;
}
