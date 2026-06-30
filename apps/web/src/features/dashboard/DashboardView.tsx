import type { DashboardResult } from "@cunote/contracts";
import { ArrowRight, Download } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  return (
    <main className="dashboard-shell">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/dashboard" })} />

      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">매칭 대시보드</p>
          <h1>{companyTitle(dashboard)}의 기회 맵</h1>
          <p>
            적격과 확인 필요를 분리하고, 지금 할 일을 전역 큐로 정렬했습니다.
          </p>
          <div className="saas-hero-actions">
            <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/api/web/dashboard/report">
              <Download data-icon="inline-start" />
              대시보드 리포트
            </a>
          </div>
        </div>
        <div className="dashboard-summary-grid">
          <SummaryMetric label="지금 적격" value={`${dashboard.counts.eligible}건`} />
          <SummaryMetric label="확인 필요" value={`${dashboard.counts.conditional}건`} />
          <SummaryMetric label="부적격" value={`${dashboard.counts.ineligible}건`} />
          <SummaryMetric label="마감 임박" value={`${dashboard.counts.deadlineSoon}건`} />
        </div>
      </section>

      <DashboardOnboardingPrompt progress={onboardingProgress} />

      <CompanySettingsPanel />

      {dashboard.nextQuestion ? <ProgressiveQuestionCard question={dashboard.nextQuestion} /> : null}

      <section className="dashboard-grid">
        <div className="dashboard-sidebar-stack">
          <NotificationFeedPanel feed={notificationFeed} />
          <ActionQueuePanel actions={dashboard.actionQueue} />
        </div>
        <OpportunityMap matches={dashboard.matches} />
      </section>

      <RoadmapStrip nodes={dashboard.roadmap} />
    </main>
  );
}

function DashboardOnboardingPrompt({ progress }: { progress: OnboardingProgress }) {
  if (!progress.nextStep) return null;

  return (
    <Card className="dashboard-onboarding-card">
      <CardContent className="dashboard-onboarding-content">
        <div className="dashboard-onboarding-copy">
          <div className="dashboard-onboarding-heading">
            <span className="eyebrow">설정 완료도</span>
            <StatusBadge tone="warning">{progress.completionRatio}%</StatusBadge>
          </div>
          <h2>{progress.nextStep.title} 보강이 필요합니다</h2>
          <p>{progress.summary}</p>
          <div className="dashboard-onboarding-meter" aria-label={`설정 완료도 ${progress.completionRatio}%`}>
            <span style={{ width: `${progress.completionRatio}%` }} />
          </div>
        </div>
        <div className="dashboard-onboarding-actions">
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
  return <MetricCard className="dashboard-metric" label={label} value={value} />;
}

function companyTitle(dashboard: DashboardResult): string {
  const parts = [
    dashboard.company.region,
    dashboard.company.size,
    dashboard.company.bizAgeMonths === null ? null : `업력 ${Math.floor(dashboard.company.bizAgeMonths / 12)}년`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "샘플 기업";
}
