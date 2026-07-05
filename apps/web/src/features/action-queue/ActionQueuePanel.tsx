import type { ActionQueueItem } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

export function ActionQueuePanel({ actions }: { actions: ActionQueueItem[] }) {
  return (
    <Card aria-labelledby="action-queue-title">
      <CardHeader>
        <CardTitle id="action-queue-title">이번 주 먼저 할 일</CardTitle>
        <CardDescription>매칭 결과에 영향을 주는 우선 행동입니다.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {actions.length > 0 ? actions.map((action) => (
          <div key={action.id} className="flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-background p-4">
            <div className="flex items-start justify-between gap-3">
              <StatusBadge tone={action.urgency === "high" ? "danger" : action.urgency === "medium" ? "warning" : "neutral"}>
                {actionKindLabel(action.kind)}
              </StatusBadge>
              <strong className="text-sm tabular-nums text-muted-foreground">{action.score}</strong>
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold leading-5 text-foreground">{action.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{action.reason}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{action.affectedGrantCount}건 영향</span>
              <span aria-hidden="true">/</span>
              <span>{effortLabel(action.effort)}</span>
            </div>
            <a className={buttonVariants({ variant: "outline", size: "sm", className: "w-full" })} href={actionHref(action)}>
              {action.ctaLabel}
            </a>
          </div>
        )) : (
          <Empty>
            <EmptyDescription>지금 바로 제안할 행동이 없습니다.</EmptyDescription>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function actionKindLabel(kind: ActionQueueItem["kind"]): string {
  const labels: Record<ActionQueueItem["kind"], string> = {
    input: "입력",
    acquire: "취득",
    apply: "신청",
    enrich: "보강",
    review: "원문 확인",
  };
  return labels[kind];
}

function effortLabel(effort: ActionQueueItem["effort"]): string {
  if (effort === "quick") return "빠름";
  if (effort === "medium") return "보통";
  return "긴 작업";
}

function actionHref(action: ActionQueueItem): string {
  if (action.kind === "input") return "#next-question";
  if (action.target.startsWith("#")) return action.target;
  if (action.target.startsWith("/")) return action.target;
  if (/^https?:\/\//.test(action.target)) return action.target;

  const firstGrantId = action.affectedGrantIds[0];
  if (firstGrantId) return `/grants/${encodeURIComponent(firstGrantId)}`;
  return "/dashboard";
}
