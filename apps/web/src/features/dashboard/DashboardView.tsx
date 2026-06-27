import type { DashboardResult, NotificationFeedResult } from "@cunote/contracts";
import { ActionQueuePanel } from "@/features/action-queue/ActionQueuePanel";
import { CompanySettingsPanel } from "@/features/dashboard/CompanySettingsPanel";
import { NotificationFeedPanel } from "@/features/dashboard/NotificationFeedPanel";
import { ProgressiveQuestionCard } from "@/features/dashboard/ProgressiveQuestionCard";
import { OpportunityMap } from "@/features/opportunity-map/OpportunityMap";
import { RoadmapStrip } from "@/features/roadmap/RoadmapStrip";

export function DashboardView({
  dashboard,
  notificationFeed,
}: {
  dashboard: DashboardResult;
  notificationFeed: NotificationFeedResult;
}) {
  return (
    <main className="dashboard-shell">
      <header className="dashboard-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <nav>
          <a href="/">다시 조회</a>
          <a href="/roadmap">로드맵</a>
          <a href="/internal/live-match">내부 검증</a>
        </nav>
      </header>

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
  return (
    <div className="dashboard-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function companyTitle(dashboard: DashboardResult): string {
  const parts = [
    dashboard.company.region,
    dashboard.company.size,
    dashboard.company.bizAgeMonths === null ? null : `업력 ${Math.floor(dashboard.company.bizAgeMonths / 12)}년`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "샘플 기업";
}
