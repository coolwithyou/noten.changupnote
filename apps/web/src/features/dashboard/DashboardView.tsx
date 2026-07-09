import type { DashboardResult } from "@cunote/contracts";
import { ArrowRight, Download } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { HeaderUser } from "@/lib/server/auth/session";
import type { NotificationCenterResult } from "@/lib/notifications/types";
import type { OnboardingProgress } from "@/lib/server/onboarding/onboardingProgress";
import { ActionQueuePanel } from "@/features/action-queue/ActionQueuePanel";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";
import { NotificationFeedPanel } from "@/features/dashboard/NotificationFeedPanel";
import { ProgressiveQuestionCard } from "@/features/dashboard/ProgressiveQuestionCard";
import { OpportunityMap } from "@/features/opportunity-map/OpportunityMap";
import { RoadmapStrip } from "@/features/roadmap/RoadmapStrip";

export function DashboardView({
  dashboard,
  notificationFeed,
  onboardingProgress,
  user = null,
}: {
  dashboard: DashboardResult;
  notificationFeed: NotificationCenterResult;
  onboardingProgress: OnboardingProgress;
  user?: HeaderUser | null;
}) {
  const counts = dashboardTrustCounts(dashboard.counts);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/dashboard" })} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.8fr)] lg:items-end">
          <div className="flex min-w-0 flex-col gap-4">
            <StatusBadge tone="brand">매칭 대시보드</StatusBadge>
            <div className="flex flex-col gap-3">
              <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
                {companyTitle(dashboard)}의 기회 맵
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground">
                적격과 확인 필요를 분리하고, 지금 할 일을 전역 큐로 정렬했습니다.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/api/web/dashboard/report">
                <Download data-icon="inline-start" />
                대시보드 리포트
              </a>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SummaryMetric label="지금 적격" value={`${counts.recommendable}건`} />
            <SummaryMetric label="확인 필요" value={`${counts.reviewNeeded}건`} />
            <SummaryMetric label="부적격" value={`${counts.notRecommended}건`} />
            <SummaryMetric label="마감 임박" value={`${dashboard.counts.deadlineSoon}건`} />
          </div>
        </section>

        <DashboardOnboardingPrompt progress={onboardingProgress} />

        <section className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            <ActionQueuePanel actions={dashboard.actionQueue} />
            <NotificationFeedPanel feed={notificationFeed} />
          </div>
          <OpportunityMap matches={dashboard.matches} />
        </section>

        <CompanySettingsPanel />

        {dashboard.nextQuestion ? <ProgressiveQuestionCard question={dashboard.nextQuestion} /> : null}

        <RoadmapStrip nodes={dashboard.roadmap} />
      </div>
    </main>
  );
}

function dashboardTrustCounts(counts: DashboardResult["counts"]) {
  return {
    recommendable: counts.recommendable ?? counts.eligible,
    reviewNeeded: counts.reviewNeeded ?? counts.conditional,
    notRecommended: counts.notRecommended ?? counts.ineligible,
  };
}

function DashboardOnboardingPrompt({ progress }: { progress: OnboardingProgress }) {
  if (!progress.nextStep) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{progress.nextStep.title} 보강이 필요합니다</CardTitle>
        <CardDescription>{progress.summary}</CardDescription>
        <CardAction>
          <StatusBadge tone="warning">{progress.completionRatio}%</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <Progress value={progress.completionRatio} aria-label={`설정 완료도 ${progress.completionRatio}%`} />
        <div className="flex flex-wrap items-center gap-2">
          <a className={buttonVariants({ size: "sm" })} href={progress.nextStep.actionHref}>
            {progress.nextStep.actionLabel}
            <ArrowRight data-icon="inline-end" />
          </a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/onboarding">
            전체 보기
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <MetricCard label={label} value={value} />;
}

function companyTitle(dashboard: DashboardResult): string {
  const parts = [
    dashboard.company.region,
    dashboard.company.size,
    dashboard.company.bizAgeMonths === null ? null : `업력 ${Math.floor(dashboard.company.bizAgeMonths / 12)}년`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "샘플 기업";
}
