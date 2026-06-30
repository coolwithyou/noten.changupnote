"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import type { ActionResult, NotificationItem } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import type {
  NotificationCenterItem,
  NotificationCenterResult,
  NotificationReceiptAction,
} from "@/lib/notifications/types";

export function NotificationFeedPanel({
  feed,
  title = "변경 알림",
  limit = 5,
}: {
  feed: NotificationCenterResult;
  title?: string;
  limit?: number;
}) {
  const [items, setItems] = useState(feed.notifications);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const visibleItems = useMemo(
    () => items.filter((item) => item.status !== "dismissed").slice(0, limit),
    [items, limit],
  );
  const unreadCount = visibleItems.filter((item) => item.status === "unread").length;

  async function updateReceipt(item: NotificationCenterItem, action: NotificationReceiptAction) {
    setPendingId(item.id);
    try {
      const response = await fetch("/api/web/notification-feed/receipt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ notificationId: item.id, action }),
      });
      const payload = await response.json() as ActionResult<NotificationCenterItem>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "알림 상태를 저장하지 못했습니다.");
      }
      setItems((current) => current.map((row) => row.id === payload.data!.id ? payload.data! : row));
    } catch {
      setItems((current) => current.map((row) => row.id === item.id
        ? {
            ...row,
            status: action === "dismiss" ? "dismissed" : "read",
            readAt: row.readAt ?? new Date().toISOString(),
            dismissedAt: action === "dismiss" ? new Date().toISOString() : row.dismissedAt,
          }
        : row));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card className="dashboard-panel notification-feed-panel" aria-labelledby="notification-feed-title">
      <div className="panel-heading inline">
        <div>
          <span className="eyebrow">알림</span>
          <h2 id="notification-feed-title">{title}</h2>
        </div>
        <div className="notification-feed-summary">
          <StatusBadge tone={unreadCount > 0 ? "brand" : "neutral"}>읽지 않음 {unreadCount}</StatusBadge>
          <time dateTime={feed.generatedAt}>{formatGeneratedAt(feed.generatedAt)}</time>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/web/notification-feed/report">
            <Download data-icon="inline-start" />
            리포트
          </a>
        </div>
      </div>
      <div className="notification-feed-list">
        {visibleItems.length > 0 ? visibleItems.map((item) => (
          <Card className={`notification-feed-item ${item.priority} ${item.status}`} key={item.id} size="sm">
            <CardContent className="p-0">
              <a href={item.href} onClick={() => void updateReceipt(item, "read")}>
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
              <div className="notification-feed-actions">
                {item.status === "unread" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pendingId === item.id}
                    onClick={() => void updateReceipt(item, "read")}
                  >
                    <CheckCircle2 data-icon="inline-start" />
                    읽음
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pendingId === item.id}
                  onClick={() => void updateReceipt(item, "dismiss")}
                >
                  <XCircle data-icon="inline-start" />
                  숨김
                </Button>
              </div>
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
  if (dDay < 0) return `${Math.abs(dDay)}일 지남`;
  if (dDay === 0) return "오늘";
  return `D-${dDay}`;
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
