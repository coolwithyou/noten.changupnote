"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  ActionResult,
  DashboardResult,
  GrantConfirmationSubmitResult,
  MatchCard,
  MatchingProfileView,
} from "@cunote/contracts";
import { Button } from "@/components/ui/button";
import { COMPANY_CONTEXT_HEADER, companyScopedFetch, withCompanyContext } from "@/lib/navigation/companyContext";
import { createMatchJourneyRecorder } from "@/lib/client/matchJourney";
import { observeProductCards } from "@/lib/client/productCardExposure";
import { ConfirmationSheet } from "@/features/match-results/ConfirmationSheet";
import { MatchGroupSections } from "@/features/match-results/MatchGroupSections";
import { groupMatchesForDisplay } from "@/features/match-results/logic";
import { dashboardPrecision } from "@/features/dashboard/dashboardPresentation";
import {
  dashboardMatchesPagePath,
  initialDashboardMatchCursor,
  mergeUniqueMatches,
} from "@/features/dashboard/dashboardMatchPagination";

interface MatchesPagePayload {
  matches: MatchCard[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

/**
 * 로그인 기회 맵 목록 — 공통 섹션(MatchGroupSections)에 40건 단위 페이지네이션·확인 시트·여정 기록을 얹는다.
 * 불러온 매치는 첫 페이지와 합쳐 같은 그룹 규칙으로 다시 나눈다.
 */
export function DashboardMatchList({
  companyId,
  counts,
  matches,
  profileView,
}: {
  companyId: string;
  counts: DashboardResult["counts"];
  matches: MatchCard[];
  profileView: MatchingProfileView;
}) {
  const router = useRouter();
  const initialTotal = fullResultCount(counts, matches.length);
  const [serverMatches, setServerMatches] = useState(matches);
  const [allMatches, setAllMatches] = useState(matches);
  const [reportedCount, setReportedCount] = useState(initialTotal);
  const [cursor, setCursor] = useState<string | null>(() => initialDashboardMatchCursor(matches.length, initialTotal));
  const [requestState, setRequestState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<MatchCard | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recordJourney] = useState(createMatchJourneyRecorder);
  const rootRef = useRef<HTMLDivElement>(null);

  // 서버가 새 목록을 내려주면(router.refresh 등) 불러온 페이지를 버리고 첫 페이지부터 다시 시작한다.
  if (serverMatches !== matches) {
    setServerMatches(matches);
    setAllMatches(matches);
    setReportedCount(initialTotal);
    setCursor(initialDashboardMatchCursor(matches.length, initialTotal));
  }

  useEffect(() => { recordJourney.begin(companyId); }, [companyId, recordJourney]);
  useEffect(() => {
    if (!rootRef.current) return;
    const tokens = new Map(allMatches.flatMap((match) => match.exposureToken ? [[match.grantId, match.exposureToken] as const] : []));
    return observeProductCards(rootRef.current, tokens, companyId);
  }, [allMatches, companyId]);

  const groups = groupMatchesForDisplay(allMatches);
  const precision = dashboardPrecision(profileView);
  const unavailableCount = Math.max(0, reportedCount - allMatches.length);
  const loading = requestState === "loading";

  function openConfirmation(match: MatchCard) {
    recordJourney(companyId, match, "confirmation_start");
    setConfirmTarget(match);
    setConfirmOpen(true);
  }

  function applyConfirmationResult(result: GrantConfirmationSubmitResult) {
    const updated = result.match;
    if (updated) {
      setAllMatches((current) => current.map((match) => (match.grantId === updated.grantId ? updated : match)));
    }
    toast.info(result.refresh.status === "failed" || result.refresh.status === "stale"
      ? "답변은 저장됐어요. 최신 판정을 다시 확인하고 있어요."
      : result.refresh.plannedCount > 1
        ? `같은 회사 정보를 쓰는 공고 ${result.refresh.plannedCount.toLocaleString("ko-KR")}건을 함께 다시 확인했어요.`
        : "답변을 반영해 최신 판정을 확인하고 있어요.");
    router.refresh();
  }

  function prepare(grantId: string) {
    const match = allMatches.find((item) => item.grantId === grantId);
    if (match) recordJourney(companyId, match, "preparation_start");
    router.push(withCompanyContext(`/grants/${encodeURIComponent(grantId)}`, companyId));
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setRequestState("loading");
    setError(null);
    try {
      const response = await companyScopedFetch(dashboardMatchesPagePath(cursor), {
        cache: "no-store",
        headers: { [COMPANY_CONTEXT_HEADER]: companyId },
      });
      const payload = await response.json() as ActionResult<MatchesPagePayload>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "다음 매칭 결과를 불러오지 못했습니다.");
      }
      const page = payload.data;
      setAllMatches((current) => mergeUniqueMatches(current, page.matches));
      setReportedCount(page.total);
      setCursor(page.hasMore ? page.cursor : null);
      setRequestState("idle");
    } catch (caught) {
      setRequestState("error");
      setError(caught instanceof Error ? caught.message : "다음 매칭 결과를 불러오지 못했습니다.");
    }
  }

  return (
    <div ref={rootRef}>
      <MatchGroupSections
        groups={groups}
        companyId={companyId}
        onOpenConfirmation={openConfirmation}
        onConfirmationSaved={applyConfirmationResult}
        onPrepare={prepare}
        onDetailOpen={(match) => recordJourney(companyId, match, "detail_open")}
        emptyCopy="현재 확인된 매칭 결과가 없어요."
      >
        {cursor ? (
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            onClick={() => void loadMore()}
            className="mt-6 w-full text-text-secondary"
          >
            {loading ? "불러오는 중" : "다음 40건 불러오기"}
          </Button>
        ) : null}
        {error ? (
          <p className="mt-2 px-1 text-center text-sm leading-5 text-destructive" role="alert">
            {error} 다시 시도해 주세요.
          </p>
        ) : null}
        {unavailableCount > 0 ? (
          <p className="mt-2 px-1 text-center text-xs leading-5 text-text-tertiary">
            전체 {reportedCount.toLocaleString("ko-KR")}건 중 {allMatches.length.toLocaleString("ko-KR")}건을 불러왔어요.
          </p>
        ) : null}
      </MatchGroupSections>

      <div className="mt-8 flex justify-center">
        <a
          href="/settings#company-settings"
          className="inline-flex w-fit rounded-full border border-border-subtle bg-surface-soft px-5 py-2.5 text-center text-sm text-text-secondary no-underline hover:bg-surface-muted"
        >
          자동으로 확인한 정보 {precision.known.toLocaleString("ko-KR")}개 · 직접 채울 정보 {precision.remaining.toLocaleString("ko-KR")}개 · 보기
        </a>
      </div>

      {confirmTarget ? (
        <ConfirmationSheet
          companyId={companyId}
          grantId={confirmTarget.grantId}
          grantTitle={confirmTarget.title}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onSaved={applyConfirmationResult}
        />
      ) : null}
    </div>
  );
}

/** 전체 비교 건수 — 추천 tier 3분류 합이 있으면 그것, 없으면 판정 3분류 합, 그마저 0이면 불러온 건수. */
export function fullResultCount(counts: DashboardResult["counts"], fallback: number): number {
  const { recommendable, reviewNeeded, notRecommended } = counts;
  if (recommendable !== undefined && reviewNeeded !== undefined && notRecommended !== undefined) {
    return recommendable + reviewNeeded + notRecommended;
  }
  const total = counts.eligible + counts.conditional + counts.ineligible;
  return total > 0 ? total : fallback;
}
