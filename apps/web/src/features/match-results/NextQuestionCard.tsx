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
            이 조건부터 확인해 보세요
          </Badge>
          <h2 className="mt-3 text-lg leading-[1.45] font-extrabold tracking-[-0.3px] text-ink-strong sm:text-2xl sm:tracking-[-0.5px]">
            {question.prompt}
          </h2>
          {question.affectedGrantCount > 0 ? (
            <p className="mt-2 text-[13.5px] font-semibold text-brand-hover sm:text-[15px]">
              답하면 공고 {question.affectedGrantCount.toLocaleString("ko-KR")}건의 판정을 다시 확인해요
            </p>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-text-secondary">
            답변에 따라 조건 충족 여부가 달라져요.
            {(question.sourceReviewRemainingGrantCount ?? 0) > 0
              ? ` 이 중 ${question.sourceReviewRemainingGrantCount}건은 답변 후에도 별도 공고 조건 확인이 남아요.`
              : ""}
          </p>
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
  const coverageCopy =
    impact.coverageDelta !== 0
      ? `기업정보 확인 ${impact.previousKnown}개 → ${impact.nextKnown}개`
      : null;

  return (
    <section className="rounded-2xl border border-border-mint-soft bg-surface-mint px-5 py-[18px] text-brand-mint-ink">
      <div className="flex items-center gap-2 text-[15px] font-extrabold">
        <CheckIcon className="size-4" strokeWidth={3} aria-hidden />
        답변을 기록했어요
      </div>
      <p className="mt-1.5 text-sm leading-6 text-text-nav">
        {impact.changed === 0
          ? (impact.resolvedConditions ?? 0) > 0
            ? `현재 비교한 공고에서 미확인 조건 ${impact.resolvedConditions}개를 확인했어요. 공고 전체 판정은 아직 같아요.`
            : "현재 비교한 공고의 전체 판정은 그대로예요. 답변은 기록했으며 다른 미확인 조건이 남아 있을 수 있어요."
          : movementParts.join(" · ")}
        {coverageCopy ? ` ${impact.changed === 0 ? "" : "· "}${coverageCopy}` : ""}
      </p>
    </section>
  );
}
