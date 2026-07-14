"use client";

import { CheckIcon } from "lucide-react";
import type { MatchingProfileAnswerRequest, NextQuestionDto } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import type { AnswerImpactSummary } from "./logic";
import { TeaserQuestionForm } from "./TeaserQuestionForm";

export function NextQuestionCard({
  question,
  impact,
  onAnswer,
  submitting,
}: {
  question: NextQuestionDto | null;
  impact: AnswerImpactSummary | null;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {impact ? <AnswerImpactCard impact={impact} /> : null}
      {question ? (
        <section
          id="next-question"
          className="rounded-[20px] border-[1.5px] border-border-card-hover bg-landing-question px-5 py-5 shadow-[var(--shadow-landing-question)] sm:px-7 sm:py-7"
        >
          <Badge className="h-auto rounded-full bg-grad-cta px-[13px] py-[5px] text-xs font-extrabold text-primary-foreground shadow-[var(--shadow-chip-brand)]">
            이것만 답하면 돼요
          </Badge>
          <h2 className="mt-3 text-lg leading-[1.45] font-extrabold tracking-[-0.3px] text-ink-strong sm:text-2xl sm:tracking-[-0.5px]">
            {question.prompt}
          </h2>
          {question.affectedGrantCount > 0 ? (
            <p className="mt-2 text-[13.5px] font-semibold text-brand-hover sm:text-[15px]">
              답하면 공고 {question.affectedGrantCount.toLocaleString("ko-KR")}건의 판정을 다시 확인해요
            </p>
          ) : null}
          <div className="mt-5">
            <TeaserQuestionForm
              question={question}
              onAnswer={onAnswer}
              submitting={submitting}
              variant="spotlight"
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AnswerImpactCard({ impact }: { impact: AnswerImpactSummary }) {
  const movementParts = [
    impact.newlyOpen > 0 ? `새로 확정 ${impact.newlyOpen}건` : null,
    impact.newlyClosed > 0 ? `대상 아님으로 정리 ${impact.newlyClosed}건` : null,
  ].filter((value): value is string => value !== null);
  const precisionCopy =
    impact.precisionDelta !== 0
      ? `정밀도 ${impact.previousPrecision}% → ${impact.nextPrecision}%`
      : null;

  return (
    <section className="rounded-2xl border border-border-mint-soft bg-surface-mint px-5 py-[18px] text-brand-mint-ink">
      <div className="flex items-center gap-2 text-[15px] font-extrabold">
        <CheckIcon className="size-4" strokeWidth={3} aria-hidden />
        답변을 기록했어요
      </div>
      <p className="mt-1.5 text-sm leading-6 text-text-nav">
        {impact.changed === 0
          ? "이 답변으로 바뀐 공고는 없어요."
          : movementParts.join(" · ")}
        {precisionCopy ? ` ${impact.changed === 0 ? "" : "· "}${precisionCopy}` : ""}
      </p>
    </section>
  );
}
