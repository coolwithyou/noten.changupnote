import type { DashboardResult, MatchCard, OpportunityBucket, RoadmapNode, RuleTraceChip, SupportAmount } from "@cunote/contracts";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import type { HeaderUser } from "@/lib/server/auth/session";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

const ROADMAP_BUCKETS: Array<{
  bucket: OpportunityBucket;
  title: string;
  description: string;
}> = [
  {
    bucket: "now",
    title: "지금 적격",
    description: "필수 조건이 충족되어 바로 검토할 수 있는 공고입니다.",
  },
  {
    bucket: "soon",
    title: "곧 적격",
    description: "업력처럼 시간이 지나면 열릴 가능성이 있는 공고입니다.",
  },
  {
    bucket: "preparable",
    title: "준비하면 적격",
    description: "인증, 서류, 속성 보강으로 잠금 해제가 필요한 공고입니다.",
  },
  {
    bucket: "conditional",
    title: "조건부 확인",
    description: "추가 입력 또는 원문 확인 후 확정 판단해야 하는 공고입니다.",
  },
];

export function RoadmapView({
  dashboard,
  user = null,
}: {
  dashboard: DashboardResult;
  user?: HeaderUser | null;
}) {
  const matchesById = new Map(dashboard.matches.map((match) => [match.grantId, match]));
  const bucketCounts = ROADMAP_BUCKETS.map((bucket) => ({
    ...bucket,
    count: dashboard.roadmap.filter((node) => node.bucket === bucket.bucket).length,
  }));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/roadmap" })} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-end">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">전략 로드맵</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              시간과 조건으로 다시 보는 지원사업 기회
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
              지금 가능한 공고와 앞으로 열릴 공고를 분리해 보여줍니다. 확인 필요 조건은 다음 입력과 신청 준비의 출발점입니다.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3" aria-label="로드맵 구간 요약">
            {bucketCounts.map((bucket) => (
              <MetricCard key={bucket.bucket} label={bucket.title} value={`${bucket.count}건`} />
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2" aria-label="로드맵 구간">
          {ROADMAP_BUCKETS.map((bucket) => {
            const nodes = dashboard.roadmap.filter((node) => node.bucket === bucket.bucket);
            return (
              <Card key={bucket.bucket}>
                <CardHeader>
                  <CardTitle>{bucket.title}</CardTitle>
                  <CardDescription>{bucket.description}</CardDescription>
                  <CardAction>
                    <StatusBadge tone={bucketTone(bucket.bucket)}>{nodes.length}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {nodes.map((node) => (
                    <RoadmapCard
                      key={`${node.bucket}:${node.grantId}`}
                      node={node}
                      match={matchesById.get(node.grantId) ?? null}
                    />
                  ))}
                  {nodes.length === 0 ? (
                    <Empty className="min-h-48">
                      <EmptyDescription>해당 구간의 공고가 없습니다.</EmptyDescription>
                    </Empty>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function RoadmapCard({ node, match }: { node: RoadmapNode; match: MatchCard | null }) {
  const href = `/grants/${encodeURIComponent(node.grantId)}`;
  const traces = actionableTraces(match).slice(0, 3);

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
      <a className="flex flex-col gap-3" href={href}>
        <div className="flex items-center justify-between gap-3">
          <StatusBadge tone={bucketTone(node.bucket)}>
            {bucketLabel(node.bucket)}
          </StatusBadge>
          <span className="text-xs font-medium text-muted-foreground">{formatDday(match?.dDay ?? null)}</span>
        </div>
        <h3 className="text-sm font-semibold leading-5 text-foreground">{node.title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{node.unlock?.detail ?? "현재 회사 조건 기준으로 표시됩니다."}</p>
        {node.unlock?.etaDate ? (
          <time className="text-xs text-muted-foreground" dateTime={node.unlock.etaDate}>{formatEtaDate(node.unlock.etaDate)}</time>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{match?.agency ?? "기관 확인 필요"}</span>
          <strong className="font-semibold text-foreground">{match ? `적합도 ${match.fitScore}` : "점수 확인"}</strong>
        </div>
        <span className="text-xs font-medium text-muted-foreground">{formatSupportAmount(match?.supportAmount ?? null)}</span>
      </a>
      {traces.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="주요 조건">
          {traces.map((trace) => (
            <StatusBadge key={`${trace.dimension}:${trace.kind}:${trace.label}`} tone={trace.result === "pass" ? "success" : trace.result === "fail" ? "danger" : "warning"}>
              {trace.label}
            </StatusBadge>
          ))}
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}

function actionableTraces(match: MatchCard | null): RuleTraceChip[] {
  if (!match) return [];
  const actionable = match.ruleTrace.filter((trace) => trace.result !== "pass");
  return actionable.length > 0 ? actionable : match.ruleTrace.slice(0, 2);
}

function bucketLabel(bucket: OpportunityBucket): string {
  if (bucket === "now") return "지금";
  if (bucket === "soon") return "곧";
  if (bucket === "preparable") return "준비";
  return "확인";
}

function bucketTone(bucket: OpportunityBucket) {
  if (bucket === "now") return "success";
  if (bucket === "soon") return "neutral";
  if (bucket === "preparable") return "brand";
  return "warning";
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감 확인";
  if (value === 0) return "오늘 마감";
  return `D-${value}`;
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}

function formatSupportAmount(amount: SupportAmount | null): string {
  if (!amount) return "금액 확인 필요";
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}
