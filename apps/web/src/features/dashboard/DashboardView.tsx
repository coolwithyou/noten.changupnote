import type { ActionQueueItem, DashboardResult, MatchingProfileView } from "@cunote/contracts";
import { AlarmClock, CircleCheckBig } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DashboardMatchList } from "@/features/dashboard/DashboardMatchList";
import { dashboardActionHref } from "@/features/dashboard/dashboardPresentation";

const KOREA_TIME_ZONE = "Asia/Seoul";

/**
 * 로그인 기회 맵(`/dashboard`, 디자인 01). 헤더(h1 기회 맵 + 기준 캡션 + 정렬 라벨) → 오늘 확인할 것(컴팩트) →
 * 공통 섹션 목록. 탭·정밀도 게이지는 두지 않는다(백분율 금지).
 */
export function DashboardView({
  dashboard,
  companyId,
}: {
  dashboard: DashboardResult & { profileView: MatchingProfileView };
  companyId: string;
}) {
  const primaryAction = selectPrimaryAction(dashboard.actionQueue);
  const companyName = dashboard.company.name?.trim() || null;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-5 py-6 sm:px-6 sm:py-[52px]">
      <header className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl leading-[1.3] font-extrabold tracking-[-0.5px] text-ink-strong">기회 맵</h1>
          <p className="text-[13px] leading-[1.55] text-text-secondary">
            {dashboardHeaderCaption({ companyName, asOf: dashboard.profileView.asOf, counts: dashboard.counts })}
          </p>
        </div>
        <span className="shrink-0 text-[13px] font-bold text-text-tertiary">관련성 높은 순</span>
      </header>

      <PrimaryActionCard action={primaryAction} />

      <DashboardMatchList
        key={`${companyId}:${dashboard.profileView.asOf}`}
        companyId={companyId}
        counts={dashboard.counts}
        matches={dashboard.matches}
        profileView={dashboard.profileView}
      />
    </div>
  );
}

/**
 * 오늘 확인할 것 하나 — 디자인 01에는 없지만 다음 질문 진입점이라 컴팩트하게 유지한다.
 */
function PrimaryActionCard({ action }: { action: ActionQueueItem | null }) {
  if (!action) {
    return (
      <Card className="mt-5 gap-0 rounded-2xl border border-border-mint-soft bg-surface-soft py-0 ring-0 shadow-none">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 px-5 py-4">
          <CircleCheckBig className="mt-0.5 size-5 text-brand-mint-ink" aria-hidden />
          <div className="min-w-0">
            <CardTitle className="text-[15px] leading-snug font-extrabold tracking-[-0.2px] text-ink">
              지금 바로 제안할 행동이 없어요
            </CardTitle>
            <CardDescription className="mt-1 text-[13.5px] leading-5 text-text-nav">
              새 매칭이나 마감 변화가 생기면 가장 먼저 볼 일을 여기에 알려드릴게요.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="mt-5 gap-0 rounded-2xl border border-brand-tint bg-surface-brand py-0 ring-0 shadow-none">
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 px-5 pt-4 pb-0">
        <AlarmClock className="mt-0.5 size-5 text-brand" aria-hidden />
        <div className="min-w-0">
          <CardTitle className="text-[15px] leading-snug font-extrabold tracking-[-0.2px] text-ink">
            {action.title}
          </CardTitle>
          <CardDescription className="mt-1 text-[13.5px] leading-5 text-text-nav">
            {action.reason}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 px-5 pt-3 pb-4">
        <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <a className={buttonVariants({ size: "sm" })} href={dashboardActionHref(action)}>
            {action.ctaLabel}
          </a>
          {action.affectedGrantCount > 0 ? (
            <p className="text-xs text-text-tertiary">
              공고 {action.affectedGrantCount.toLocaleString("ko-KR")}건의 판정에 영향을 줘요
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** buildActionQueue가 계산한 점수를 그대로 사용해 표면에 노출할 한 건만 고른다. */
export function selectPrimaryAction(actions: readonly ActionQueueItem[]): ActionQueueItem | null {
  let primary: ActionQueueItem | null = null;
  for (const action of actions) {
    if (!primary || action.score > primary.score) primary = action;
  }
  return primary;
}

/**
 * 헤더 캡션 — "{회사명}의 저장된 정보 기준 · M월 D일 모집 중 N건 중 관련 후보를 골랐어요".
 * 전체 비교 건수를 알 수 없으면 "모집 중 N건 중" 구를 뺀다. 날짜는 profileView.asOf, 없으면 오늘(Asia/Seoul).
 */
export function dashboardHeaderCaption({
  companyName,
  asOf,
  counts,
  now = new Date(),
}: {
  companyName: string | null;
  asOf: string | null | undefined;
  counts: DashboardResult["counts"];
  now?: Date;
}): string {
  const date = formatKoreanMonthDay(asOf) ?? formatKoreanMonthDay(now.toISOString()) ?? "오늘";
  const subject = companyName ? `${companyName}의 저장된 정보 기준` : "저장된 회사 정보 기준";
  const total = comparedMatchCount(counts);
  return total !== null
    ? `${subject} · ${date} 모집 중 ${total.toLocaleString("ko-KR")}건 중 관련 후보를 골랐어요`
    : `${subject} · ${date} 관련 후보를 골랐어요`;
}

/** 전체 비교 건수 — 추천 tier 3분류 합, 없으면 판정 3분류 합. 둘 다 없으면 null. */
export function comparedMatchCount(counts: DashboardResult["counts"]): number | null {
  const { recommendable, reviewNeeded, notRecommended } = counts;
  if (recommendable !== undefined && reviewNeeded !== undefined && notRecommended !== undefined) {
    return recommendable + reviewNeeded + notRecommended;
  }
  const total = counts.eligible + counts.conditional + counts.ineligible;
  return total > 0 ? total : null;
}

function formatKoreanMonthDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? new Date(`${trimmed}T00:00:00+09:00`) : new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", timeZone: KOREA_TIME_ZONE }).format(date);
}
