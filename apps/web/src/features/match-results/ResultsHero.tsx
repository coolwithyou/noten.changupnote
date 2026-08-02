"use client";

import type { ProductTeaserResult } from "@cunote/contracts";
import { PrecisionGauge } from "@/components/app/precision-gauge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  groupMatchesForDisplay,
  matchingProfileCoverage,
  profileCoverageLabel,
  resultsCoverageCaption,
  teaserComparisonLabel,
} from "./logic";

export function ResultsHero({
  teaser,
  onSave,
  saving,
  coverageDelta,
  empty = false,
  questionsExhausted = false,
}: {
  teaser: ProductTeaserResult;
  onSave: () => void;
  saving: boolean;
  coverageDelta?: number;
  empty?: boolean;
  /** 물어볼 질문이 소진된 상태(teaser.nextQuestion === null) — 게이지 캡션을 분기한다. */
  questionsExhausted?: boolean;
}) {
  const groups = groupMatchesForDisplay(teaser.matches);
  const coverage = matchingProfileCoverage(teaser);
  const comparisonLabel = teaserComparisonLabel(teaser);
  const openCount = teaser.counts.openNow ?? groups.open.length;
  const oneAnswerCount = teaser.counts.oneAnswer ?? groups.oneAnswer.length;
  const hasActionableMatches = openCount + oneAnswerCount > 0;

  return (
    <section>
      {empty ? null : (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-[32px] leading-[1.28] font-extrabold tracking-[-0.9px] text-ink-strong sm:text-[38px] sm:tracking-[-1px]">
              {hasActionableMatches ? (
                <>
                  지금 신청 가능 <span className="text-brand-mint-ink">{openCount}건</span>
                  <span className="hidden sm:inline"> · </span>
                  <span className="block sm:inline">
                    답하면 확정 <span className="text-brand">{oneAnswerCount}건</span>
                  </span>
                </>
              ) : (
                <>지금 정보로 확정된 공고가 없어요</>
              )}
            </h1>
            {comparisonLabel ? <p className="mt-2.5 text-sm text-text-tertiary">{comparisonLabel}</p> : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onSave}
            disabled={saving}
            className="mt-1.5 hidden w-fit shrink-0 border-surface-muted-hover bg-card text-text-nav sm:inline-flex"
          >
            {saving ? "저장 중…" : "결과 저장하기"}
          </Button>
        </div>
      )}

      <div className={cn("rounded-2xl border border-brand-tint bg-landing-step-blue px-5 py-[18px] shadow-[var(--shadow-landing-step)]", !empty && "mt-8")}>
        <PrecisionGauge
          pct={coverage.pct}
          {...(coverageDelta && coverageDelta > 0 ? { delta: `+${coverageDelta}개` } : {})}
          label={profileCoverageLabel(coverage)}
          caption={resultsCoverageCaption({ questionsExhausted, hasActionableMatches })}
          meta={`전체 기업정보 ${coverage.total}개 중 ${coverage.known}개 확인`}
        />
      </div>
    </section>
  );
}
