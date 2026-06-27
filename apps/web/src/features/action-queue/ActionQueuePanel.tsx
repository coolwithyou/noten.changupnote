import type { ActionQueueItem } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

export function ActionQueuePanel({ actions }: { actions: ActionQueueItem[] }) {
  return (
    <Card className="dashboard-panel action-panel" aria-labelledby="action-queue-title">
      <div className="panel-heading">
        <span className="eyebrow">NPC 액션 큐</span>
        <h2 id="action-queue-title">이번 주 먼저 할 일</h2>
      </div>
      <div className="action-list">
        {actions.length > 0 ? actions.map((action) => (
          <Card key={action.id} className={`action-item ${action.urgency}`} size="sm">
            <CardContent className="p-0">
              <StatusBadge className="action-kind" tone={action.urgency === "high" ? "danger" : action.urgency === "medium" ? "warning" : "neutral"}>
                {actionKindLabel(action.kind)}
              </StatusBadge>
              <h3>{action.title}</h3>
              <p>{action.reason}</p>
              <div className="action-meta">
                <span>{action.affectedGrantCount}건 영향</span>
                <span>{effortLabel(action.effort)}</span>
                <strong>{action.score}</strong>
              </div>
              <a className={buttonVariants({ variant: "outline", size: "sm", className: "action-cta" })} href={actionHref(action)}>
                {action.ctaLabel}
              </a>
            </CardContent>
          </Card>
        )) : (
          <Empty className="panel-empty">
            <EmptyDescription>지금 바로 제안할 행동이 없습니다.</EmptyDescription>
          </Empty>
        )}
      </div>
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
