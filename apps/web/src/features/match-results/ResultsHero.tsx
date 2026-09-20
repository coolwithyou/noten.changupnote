"use client";

import type { ProductTeaserResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { teaserComparisonLabel } from "./logic";

export function ResultsHero({
  teaser,
  onSave,
  saving,
  empty = false,
  savedCompany = false,
  companyName = null,
}: {
  teaser: ProductTeaserResult;
  onSave: () => void;
  saving: boolean;
  coverageDelta?: number;
  empty?: boolean;
  /** 물어볼 질문이 소진된 상태(teaser.nextQuestion === null) — 게이지 캡션을 분기한다. */
  questionsExhausted?: boolean;
  /** 서버가 같은 질문을 다시 계획했지만 현재 결과 세션에서 이미 답한 상태. */
  answeredCurrentQuestion?: boolean;
  savedCompany?: boolean;
  companyName?: string | null;
}) {
  const comparisonLabel = teaserComparisonLabel(teaser);
  const hasCandidates = teaser.matches.length > 0;
  const hasVerifiedCandidates = teaser.matches.some(
    (match) => match.matchingEvidence?.level !== "discovery",
  );
  const hasExplicitRelevance = teaser.matches.some(
    (match) => match.matchingEvidence?.level !== "discovery"
      && typeof match.ranking?.relevanceScore === "number"
      && match.ranking.relevanceScore > 0,
  );

  return (
    <section>
      {savedCompany ? (
        <p className="mb-3 text-sm text-text-secondary">
          {companyName || "이름 미등록 회사"}의 저장된 정보 기준 · 회사 변경은 설정에서 할 수 있어요
        </p>
      ) : null}
      {empty ? null : (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="max-w-[720px] text-[32px] leading-[1.28] font-extrabold tracking-[-0.9px] text-ink-strong sm:text-[38px] sm:tracking-[-1px]">
              {hasExplicitRelevance
                ? "우리 회사와 관련된 공고를 확인해 보세요"
                : hasVerifiedCandidates
                  ? "살펴볼 공고를 찾았어요"
                  : hasCandidates
                  ? "모집 중인 공고를 살펴보세요"
                  : "조건에 맞는 공고를 찾지 못했어요"}
            </h1>
            {hasCandidates ? (
              <p className="mt-2.5 text-sm leading-6 text-text-secondary">
                각 공고에서 확인된 조건과 아직 확인할 내용을 함께 안내해요.
              </p>
            ) : null}
            {comparisonLabel ? <p className="mt-2.5 text-sm text-text-tertiary">{comparisonLabel}</p> : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onSave}
            disabled={saving}
            className="mt-1.5 hidden w-fit shrink-0 border-surface-muted-hover bg-card text-text-nav sm:inline-flex"
          >
            {saving ? "처리 중…" : savedCompany ? "내 대시보드로 이동" : "결과 저장하기"}
          </Button>
        </div>
      )}

    </section>
  );
}
