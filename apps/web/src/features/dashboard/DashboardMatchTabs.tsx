"use client";

import { useState } from "react";
import type { DashboardResult, MatchCard, MatchingProfileView } from "@cunote/contracts";
import { NoticeCard, type NoticeCardStatus } from "@/components/app/notice-card";
import { PrecisionGauge } from "@/components/app/precision-gauge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  formatDday,
  groupMatchesForDisplay,
  matchVerdictStatus,
} from "@/features/match-results/logic";
import { buildSupportSummary } from "@/features/match-results/support-summary";
import { dashboardPrecision } from "@/features/dashboard/dashboardPresentation";

type DashboardTab = "open" | "one-answer" | "all";

const DEFAULT_VISIBLE_COUNT = 5;

export function DashboardMatchTabs({
  counts,
  matches,
  profileView,
}: {
  counts: DashboardResult["counts"];
  matches: MatchCard[];
  profileView: MatchingProfileView;
}) {
  const groups = groupMatchesForDisplay(matches);
  const openCount = Math.max(counts.openNow ?? 0, groups.open.length);
  const oneAnswerCount = Math.max(counts.oneAnswer ?? 0, groups.oneAnswer.length);
  const allCount = fullResultCount(counts, matches.length);
  const defaultTab: DashboardTab = groups.open.length > 0
    ? "open"
    : groups.oneAnswer.length > 0
      ? "one-answer"
      : "all";
  const precision = dashboardPrecision(profileView);

  return (
    <Tabs defaultValue={defaultTab} className="mt-10 gap-6">
      <TabsList
        aria-label="매칭 결과 상태"
        className="h-auto max-w-full justify-start gap-2 overflow-x-auto rounded-full bg-transparent p-0"
      >
        <DashboardTabTrigger value="open" label="지금 가능" count={openCount} />
        <DashboardTabTrigger value="one-answer" label="답하면 확정" count={oneAnswerCount} />
        <DashboardTabTrigger value="all" label="전체" count={allCount} />
      </TabsList>

      <div className="rounded-2xl border border-brand-tint bg-landing-step-blue px-5 py-[18px] shadow-[var(--shadow-landing-step)]">
        <PrecisionGauge
          pct={precision.pct}
          label={`매칭 정밀도 ${precision.pct}%`}
          caption="회사를 더 설명할수록 결과가 정확해져요"
          meta={`자동으로 확인 ${precision.known} · 직접 채우면 +${precision.remaining}`}
        />
      </div>

      <DashboardTabContent
        value="open"
        matches={groups.open}
        reportedCount={openCount}
        emptyCopy="현재 정보로 바로 신청할 수 있다고 확인된 공고는 아직 없어요."
      />
      <DashboardTabContent
        value="one-answer"
        matches={groups.oneAnswer}
        reportedCount={oneAnswerCount}
        emptyCopy="답변 하나로 확정할 수 있는 공고는 현재 목록에 없어요."
      />
      <DashboardTabContent
        value="all"
        matches={matches}
        reportedCount={allCount}
        emptyCopy="현재 확인된 매칭 결과가 없어요."
      />

      <a
        href="/settings#company-settings"
        className="mx-auto inline-flex w-fit rounded-full border border-border-subtle bg-surface-soft px-5 py-2.5 text-center text-sm text-text-secondary no-underline hover:bg-surface-muted"
      >
        자동으로 확인한 정보 {precision.known.toLocaleString("ko-KR")}개 · 직접 채울 정보 {precision.remaining.toLocaleString("ko-KR")}개 · 보기
      </a>
    </Tabs>
  );
}

function DashboardTabTrigger({
  value,
  label,
  count,
}: {
  value: DashboardTab;
  label: string;
  count: number;
}) {
  return (
    <TabsTrigger
      value={value}
      className="h-9 flex-none rounded-full bg-surface-hard px-4 font-bold text-text-secondary data-active:bg-brand-tint data-active:text-brand-hover"
    >
      {label}
      {count > 0 ? ` ${count.toLocaleString("ko-KR")}` : ""}
    </TabsTrigger>
  );
}

function DashboardTabContent({
  value,
  matches,
  reportedCount,
  emptyCopy,
}: {
  value: DashboardTab;
  matches: MatchCard[];
  reportedCount: number;
  emptyCopy: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleMatches = expanded ? matches : matches.slice(0, DEFAULT_VISIBLE_COUNT);
  const hiddenLoadedCount = Math.max(0, matches.length - visibleMatches.length);
  const unavailableCount = Math.max(0, reportedCount - matches.length);

  return (
    <TabsContent value={value} className="mt-0">
      {visibleMatches.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {visibleMatches.map((match) => (
            <NoticeCard
              key={match.grantId}
              title={match.title}
              dday={match.status === "upcoming" && match.dDay === null ? "접수 예정" : formatDday(match.dDay)}
              supportSummary={buildSupportSummary(match)}
              status={noticeStatus(match)}
              href={`/grants/${encodeURIComponent(match.grantId)}`}
            />
          ))}
          {hiddenLoadedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setExpanded(true)}
              className="w-full text-text-secondary"
            >
              {hiddenLoadedCount.toLocaleString("ko-KR")}건 더 보기
            </Button>
          ) : null}
          {unavailableCount > 0 ? (
            <p className="px-1 text-center text-xs leading-5 text-text-tertiary">
              우선순위가 높은 {matches.length.toLocaleString("ko-KR")}건을 먼저 보여드려요.
            </p>
          ) : null}
        </div>
      ) : (
        <Empty className="min-h-40 rounded-2xl border border-border-subtle bg-surface-soft">
          <EmptyDescription>{emptyCopy}</EmptyDescription>
        </Empty>
      )}
    </TabsContent>
  );
}

function noticeStatus(match: MatchCard): NoticeCardStatus {
  return match.status === "upcoming" ? "upcoming" : matchVerdictStatus(match);
}

function fullResultCount(counts: DashboardResult["counts"], fallback: number): number {
  const recommendable = counts.recommendable;
  const reviewNeeded = counts.reviewNeeded;
  const notRecommended = counts.notRecommended;
  if (recommendable !== undefined && reviewNeeded !== undefined && notRecommended !== undefined) {
    return recommendable + reviewNeeded + notRecommended;
  }
  const total = counts.eligible + counts.conditional + counts.ineligible;
  return total > 0 ? total : fallback;
}
