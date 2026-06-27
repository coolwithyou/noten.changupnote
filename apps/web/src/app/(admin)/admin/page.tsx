import { getOptionalAdminAccess } from "@/lib/server/auth/adminGuard";
import {
  getAdminFlywheelSnapshot,
  type AdminFlywheelSnapshot,
} from "@/lib/server/admin/flywheelStore";
import {
  getAdminRuntimeStatus,
  type AdminRuntimeStatus,
} from "@/lib/server/admin/runtimeStatus";
import { loadDueMatchTransitionPlan } from "@/lib/server/matches/transitionPlan";
import type {
  MatchTransitionAction,
  MatchTransitionPlan,
} from "@cunote/core";

export const dynamic = "force-dynamic";

const SURFACES: Array<{
  key: keyof AdminFlywheelSnapshot["counts"];
  title: string;
  body: string;
}> = [
  {
    key: "extractionLog",
    title: "extraction_log",
    body: "추출 이력과 confidence 리뷰 큐",
  },
  {
    key: "feedback",
    title: "feedback",
    body: "사용자 명시 피드백과 outcome 신호",
  },
  {
    key: "matchEvents",
    title: "match_events",
    body: "노출, 저장, 신청 클릭 행동 신호",
  },
  {
    key: "goldenSet",
    title: "golden_set",
    body: "추출/매칭 정답 기준셋",
  },
  {
    key: "evalRuns",
    title: "eval_runs",
    body: "버전별 회귀 평가 결과",
  },
  {
    key: "grantInsightSnapshots",
    title: "grant_insight_snapshots",
    body: "지원사업 아카이브 커버리지와 운영 인사이트",
  },
];

export default async function AdminPage() {
  const access = await getOptionalAdminAccess();
  const runtime = access ? getAdminRuntimeStatus() : null;
  const [snapshot, transitionPlan] = access
    ? await Promise.all([loadSnapshot(), loadTransitionPlan()])
    : [null, null];

  return (
    <main className="admin-shell">
      <header className="dashboard-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <nav>
          <a href="/dashboard">기회 맵</a>
          <a href="/internal/live-match">내부 검증</a>
        </nav>
      </header>

      <section className="admin-hero">
        <p className="eyebrow">Admin</p>
        <h1>플라이휠 운영 콘솔</h1>
        <p>라벨링, 골든셋, 평가 리포트가 붙을 어드민 경계입니다.</p>
      </section>

      {access ? (
        <>
          {runtime ? <RuntimePanel runtime={runtime} /> : null}
          <TransitionPanel plan={transitionPlan} />

          <section className="admin-grid">
            {SURFACES.map((item) => (
              <article className="admin-panel" key={item.title}>
                <span>{snapshot ? snapshot.counts[item.key].toLocaleString("ko-KR") : "대기"}</span>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
              </article>
            ))}
          </section>

          <section className="admin-panel admin-feed">
            <span>{snapshot ? formatTimestamp(snapshot.generatedAt) : "대기"}</span>
            <h2>최근 플라이휠 이벤트</h2>
            {snapshot ? (
              <div className="admin-feed-grid">
                <RecentList
                  title="extraction"
                  items={snapshot.recent.extractionLog.map((item) => `${item.status} · ${item.inputRef}`)}
                />
                <RecentList
                  title="feedback"
                  items={snapshot.recent.feedback.map((item) => `${item.type} · ${item.targetType}:${item.targetId}`)}
                />
                <RecentList
                  title="events"
                  items={snapshot.recent.matchEvents.map((item) => `${item.event} · ${item.rulesetVer} · ${item.grantId}`)}
                />
                <RecentList
                  title="golden"
                  items={snapshot.recent.goldenSet.map((item) => `${item.kind} · ${item.goldenVer}`)}
                />
                <RecentList
                  title="eval"
                  items={snapshot.recent.evalRuns.map((item) => `${item.target} · ${item.goldenVer}`)}
                />
                <RecentList
                  title="insights"
                  items={snapshot.recent.grantInsightSnapshots.map((item) => `${item.kind} · ${item.insightCount} signals`)}
                />
              </div>
            ) : (
              <p>DB 연결 전에는 카운트와 최근 항목을 대기 상태로 표시합니다.</p>
            )}
          </section>
        </>
      ) : (
        <section className="admin-panel admin-denied">
          <span>403</span>
          <h2>어드민 접근 권한 필요</h2>
          <p>현재 세션에는 어드민 role이 없습니다.</p>
        </section>
      )}
    </main>
  );
}

function RuntimePanel({ runtime }: { runtime: AdminRuntimeStatus }) {
  const rows = [
    ["repository", runtime.repositoryAdapter],
    ["data source", runtime.webDataSource],
    ["auth required", runtime.authRequired ? "true" : "false"],
    ["auth mode", runtime.authMode],
    ["providers", runtime.authProviders.length > 0 ? runtime.authProviders.join(", ") : "none"],
    ["database", runtime.databaseConfigured ? "configured" : "missing"],
  ] as const;

  return (
    <section className="admin-panel admin-runtime">
      <span>runtime</span>
      <h2>실행 구성</h2>
      <dl className="admin-runtime-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

async function loadSnapshot(): Promise<AdminFlywheelSnapshot | null> {
  try {
    return await getAdminFlywheelSnapshot();
  } catch {
    return null;
  }
}

async function loadTransitionPlan(): Promise<MatchTransitionPlan | null> {
  try {
    return await loadDueMatchTransitionPlan({ limit: 10 });
  } catch {
    return null;
  }
}

function TransitionPanel({ plan }: { plan: MatchTransitionPlan | null }) {
  const total = plan
    ? plan.counts.becomes_eligible + plan.counts.becomes_ineligible
    : null;

  return (
    <section className="admin-panel admin-transitions">
      <span>{total === null ? "대기" : `${total.toLocaleString("ko-KR")}건`}</span>
      <h2>상태 전이 예정</h2>
      {plan ? (
        <>
          <div className="admin-transition-counts">
            <strong>해금 {plan.counts.becomes_eligible.toLocaleString("ko-KR")}</strong>
            <strong>마감 {plan.counts.becomes_ineligible.toLocaleString("ko-KR")}</strong>
            <time dateTime={plan.asOf}>{formatTimestamp(plan.asOf)}</time>
          </div>
          {plan.transitions.length > 0 ? (
            <ul className="admin-transition-list">
              {plan.transitions.slice(0, 10).map((item) => (
                <TransitionItem item={item} key={`${item.companyId}:${item.grantId}:${item.kind}`} />
              ))}
            </ul>
          ) : (
            <p>현재 처리할 전이 대상이 없습니다.</p>
          )}
        </>
      ) : (
        <p>전이 플랜을 불러오지 못했습니다.</p>
      )}
    </section>
  );
}

function TransitionItem({ item }: { item: MatchTransitionAction }) {
  return (
    <li>
      <strong>{transitionLabel(item)}</strong>
      <p>{shortId(item.companyId)} · {shortId(item.grantId)}</p>
      <time dateTime={item.dueAt}>{formatTimestamp(item.dueAt)}</time>
    </li>
  );
}

function transitionLabel(item: MatchTransitionAction): string {
  return item.kind === "becomes_eligible" ? "해금 전이" : "마감 전이";
}

function RecentList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul>
          {items.slice(0, 5).map((item, index) => (
            <li key={`${title}:${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>최근 항목 없음</p>
      )}
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
