import type { NotificationFeedResult, NotificationItem } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";

export function NotificationFeedPanel({ feed }: { feed: NotificationFeedResult }) {
  return (
    <Card className="dashboard-panel notification-feed-panel" aria-labelledby="notification-feed-title">
      <div className="panel-heading inline">
        <div>
          <span className="eyebrow">알림</span>
          <h2 id="notification-feed-title">변경 알림</h2>
        </div>
        <time dateTime={feed.generatedAt}>{formatGeneratedAt(feed.generatedAt)}</time>
      </div>
      <div className="notification-feed-list">
        {feed.notifications.length > 0 ? feed.notifications.slice(0, 5).map((item) => (
          <Card className={`notification-feed-item ${item.priority}`} key={item.id} size="sm">
            <CardContent className="p-0">
              <a href={notificationHref(item)}>
                <div className="notification-feed-top">
                  <StatusBadge tone={item.priority === "high" ? "danger" : item.priority === "medium" ? "warning" : "neutral"}>
                    {kindLabel(item.kind)}
                  </StatusBadge>
                  <strong>{priorityLabel(item.priority)}</strong>
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <div className="notification-feed-meta">
                  {item.dDay !== undefined && item.dDay !== null ? <span>{dDayLabel(item.dDay)}</span> : null}
                  {item.etaDate ? <span>{item.etaDate}</span> : null}
                  <span>{item.rulesetVer}</span>
                </div>
              </a>
            </CardContent>
          </Card>
        )) : (
          <Empty className="panel-empty">
            <EmptyDescription>새 알림이 없습니다.</EmptyDescription>
          </Empty>
        )}
      </div>
    </Card>
  );
}

function notificationHref(item: NotificationItem): string {
  if (item.target.startsWith("grant:")) {
    return `/grants/${encodeURIComponent(item.target.slice("grant:".length))}`;
  }
  if (item.target.startsWith("profile:")) return "#company-settings";
  if (item.target.startsWith("/")) return item.target;
  if (/^https?:\/\//.test(item.target)) return item.target;
  return "/dashboard";
}

function kindLabel(kind: NotificationItem["kind"]): string {
  const labels: Record<NotificationItem["kind"], string> = {
    deadline: "마감",
    new_match: "신규 적격",
    soon_eligible: "곧 적격",
    needs_input: "입력 필요",
  };
  return labels[kind];
}

function priorityLabel(priority: NotificationItem["priority"]): string {
  if (priority === "high") return "높음";
  if (priority === "medium") return "중간";
  return "낮음";
}

function dDayLabel(dDay: number): string {
  if (dDay === 0) return "오늘 마감";
  return `D-${dDay}`;
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
