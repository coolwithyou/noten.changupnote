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
import { DashboardMatchTabs } from "@/features/dashboard/DashboardMatchTabs";
import { dashboardActionHref } from "@/features/dashboard/dashboardPresentation";

export function DashboardView({ dashboard }: { dashboard: DashboardResult & { profileView: MatchingProfileView } }) {
  const primaryAction = selectPrimaryAction(dashboard.actionQueue);
  const companyName = dashboard.company.name?.trim();

  return (
    <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-6 sm:py-[52px]">
      <h1 className="text-[26px] leading-[1.35] font-extrabold tracking-[-0.5px] text-ink">
        {companyName ? `${companyName}님, ` : ""}
        {primaryAction ? "오늘 확인할 것 하나예요" : "오늘 바로 확인할 일은 없어요"}
      </h1>

      <PrimaryActionCard action={primaryAction} />

      <DashboardMatchTabs
        counts={dashboard.counts}
        matches={dashboard.matches}
        profileView={dashboard.profileView}
      />
    </div>
  );
}

function PrimaryActionCard({ action }: { action: ActionQueueItem | null }) {
  if (!action) {
    return (
      <Card className="mt-6 gap-0 rounded-[20px] border border-brand-mint-soft bg-surface-soft py-0 ring-0 shadow-[var(--shadow-notice)]">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-6 py-6 sm:px-7">
          <CircleCheckBig className="mt-0.5 size-6 text-brand-mint-ink" aria-hidden />
          <div className="min-w-0">
            <CardTitle className="text-[19px] leading-snug font-extrabold tracking-[-0.3px] text-ink">
              지금 바로 제안할 행동이 없어요
            </CardTitle>
            <CardDescription className="mt-1.5 text-[14.5px] leading-6 text-text-nav">
              새 매칭이나 마감 변화가 생기면 가장 먼저 볼 일을 여기에 알려드릴게요.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="mt-6 gap-0 rounded-[20px] border border-brand-tint bg-surface-brand py-0 ring-0 shadow-[var(--shadow-landing-step)]">
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-6 pt-6 pb-0 sm:px-7">
        <AlarmClock className="mt-0.5 size-6 text-brand" aria-hidden />
        <div className="min-w-0">
          <CardTitle className="text-[19px] leading-snug font-extrabold tracking-[-0.3px] text-ink">
            {action.title}
          </CardTitle>
          <CardDescription className="mt-1.5 text-[14.5px] leading-6 text-text-nav">
            {action.reason}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-6 pt-4 pb-6 sm:px-7">
        <div className="col-start-2 flex flex-col items-start gap-2.5">
          <a className={buttonVariants()} href={dashboardActionHref(action)}>
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
