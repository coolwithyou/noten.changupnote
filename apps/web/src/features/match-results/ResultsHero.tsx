"use client";

import type { ProductTeaserResult } from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { matchHeaderCaption } from "./logic";

/**
 * 기회 맵 헤더(디자인 01) — h1 "기회 맵" + 기준 캡션, 우측에 저장·대시보드 이동 버튼.
 * 후보가 하나도 없으면 제목만 바꾸고, `empty`면 아래 NoMatchingGrantsState가 대신 그린다.
 */
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
  /** 물어볼 질문이 소진된 상태(teaser.nextQuestion === null). 호출 계약 유지용. */
  questionsExhausted?: boolean;
  /** 서버가 같은 질문을 다시 계획했지만 현재 결과 세션에서 이미 답한 상태. 호출 계약 유지용. */
  answeredCurrentQuestion?: boolean;
  savedCompany?: boolean;
  companyName?: string | null;
}) {
  if (empty) return null;
  const hasCandidates = teaser.matches.length > 0;
  const caption = matchHeaderCaption({ teaser, companyName, saved: savedCompany });

  return (
    <header className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl leading-[1.3] font-extrabold tracking-[-0.5px] text-ink-strong">
          {hasCandidates ? "기회 맵" : "조건에 맞는 공고를 찾지 못했어요"}
        </h1>
        <p className="text-[13px] leading-[1.55] text-text-secondary">{caption}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onSave}
        disabled={saving}
        className="hidden w-fit shrink-0 border-surface-muted-hover bg-card text-text-nav sm:inline-flex"
      >
        {saving ? "처리 중…" : savedCompany ? "내 대시보드로 이동" : "결과 저장하기"}
      </Button>
    </header>
  );
}
