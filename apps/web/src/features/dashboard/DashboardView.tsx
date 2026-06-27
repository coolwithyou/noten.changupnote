import type { DashboardResult, NotificationFeedResult } from "@cunote/contracts";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import type { HeaderUser } from "@/lib/server/auth/session";
import { ActionQueuePanel } from "@/features/action-queue/ActionQueuePanel";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";
import { NotificationFeedPanel } from "@/features/dashboard/NotificationFeedPanel";
import { ProgressiveQuestionCard } from "@/features/dashboard/ProgressiveQuestionCard";
import { OpportunityMap } from "@/features/opportunity-map/OpportunityMap";
import { RoadmapStrip } from "@/features/roadmap/RoadmapStrip";

export function DashboardView({
  dashboard,
  notificationFeed,
  user = null,
}: {
  dashboard: DashboardResult;
  notificationFeed: NotificationFeedResult;
  user?: HeaderUser | null;
}) {
  return (
    <main className="dashboard-shell">
      <ServiceHeader
        user={user}
        links={[
          { href: "/", label: "다시 조회" },
          { href: "/roadmap", label: "로드맵" },
          { href: "/internal/live-match", label: "내부 검증" },
        ]}
      />

      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">매칭 대시보드</p>
          <h1>{companyTitle(dashboard)}의 기회 맵</h1>
          <p>
            적격과 확인 필요를 분리하고, 지금 할 일을 전역 큐로 정렬했습니다.
          </p>
        </div>
        <div className="dashboard-summary-grid">
          <SummaryMetric label="지금 적격" value={`${dashboard.counts.eligible}건`} />
          <SummaryMetric label="확인 필요" value={`${dashboard.counts.conditional}건`} />
          <SummaryMetric label="부적격" value={`${dashboard.counts.ineligible}건`} />
          <SummaryMetric label="마감 임박" value={`${dashboard.counts.deadlineSoon}건`} />
        </div>
      </section>

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
