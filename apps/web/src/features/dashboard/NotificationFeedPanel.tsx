"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import type { ActionResult, NotificationItem } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card aria-labelledby="notification-feed-title">
      <CardHeader>
        <CardTitle id="notification-feed-title">{title}</CardTitle>
        <CardDescription>{formatGeneratedAt(feed.generatedAt)} 기준</CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusBadge tone={unreadCount > 0 ? "brand" : "neutral"}>읽지 않음 {unreadCount}</StatusBadge>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/api/web/notification-feed/report">
            <Download data-icon="inline-start" />
            리포트
          </a>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {visibleItems.length > 0 ? visibleItems.map((item) => (
          <div
            className="rounded-[var(--radius-lg)] border bg-background p-4 data-[status=unread]:border-primary/30 data-[status=unread]:bg-primary/5"
            data-priority={item.priority}
            data-status={item.status}
            key={item.id}
          >
            <div className="flex flex-col gap-3">
              <a className="flex flex-col gap-2" href={item.href} onClick={() => void updateReceipt(item, "read")}>
                <span className="flex items-center justify-between gap-3">
                  <StatusBadge tone={item.priority === "high" ? "danger" : item.priority === "medium" ? "warning" : "neutral"}>
                    {kindLabel(item.kind)}
                  </StatusBadge>
                  <strong className="text-xs font-medium text-muted-foreground">{priorityLabel(item.priority)}</strong>
                </span>
                <span className="text-sm font-semibold leading-5 text-foreground">{item.title}</span>
                <span className="text-sm leading-6 text-muted-foreground">{item.body}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {item.dDay !== undefined && item.dDay !== null ? <span>{dDayLabel(item.dDay)}</span> : null}
                  {item.etaDate ? <span>{item.etaDate}</span> : null}
                  <span>{item.rulesetVer}</span>
                </span>
              </a>
              <div className="flex flex-wrap items-center gap-2">
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
            </div>
          </div>
        )) : (
          <Empty>
            <EmptyDescription>새 알림이 없습니다.</EmptyDescription>
          </Empty>
        )}
      </CardContent>
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
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "시각 미확인";
  const kst = new Date(timestamp + 9 * 60 * 60 * 1000);
  const hour = String(kst.getUTCHours()).padStart(2, "0");
  const minute = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}
