import assert from "node:assert/strict";
import type { NotificationCenterResult } from "@/lib/notifications/types";
import { buildNotificationCenterReport, renderNotificationCenterReport } from "./notificationCenterReport";

const center: NotificationCenterResult = {
  generatedAt: "2026-06-30T00:00:00.000Z",
  unreadCount: 2,
  dismissedCount: 1,
  settings: {
    deadlineReminder: false,
    newMatch: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  },
  notifications: [
    {
      id: "deadline:grant-1",
      kind: "deadline",
      title: "마감 임박: 창업 지원",
      body: "오늘 신청 상태를 확인하세요.",
      priority: "high",
      target: "grant:grant-1",
      href: "/grants/grant-1",
      grantId: "grant-1",
      dDay: 0,
      etaDate: "2026-06-30",
      rulesetVer: "notification-v1",
      status: "unread",
      readAt: null,
      dismissedAt: null,
    },
    {
      id: "support_reply:ticket-1:message-1",
      kind: "needs_input",
      title: "운영팀 답변 도착",
      body: "문의에 공개 답변이 도착했습니다.",
      priority: "medium",
      target: "/settings?section=activity",
      href: "/settings?section=activity",
      dDay: null,
      etaDate: "2026-06-29",
      rulesetVer: "support-reply-v1",
      status: "read",
      readAt: "2026-06-30T01:00:00.000Z",
      dismissedAt: null,
    },
  ],
};

const generatedAt = new Date("2026-06-30T00:00:00.000Z");
const markdown = renderNotificationCenterReport({ center, generatedAt });
const report = buildNotificationCenterReport({ center, generatedAt });

assert(markdown.includes("# 창업노트 알림센터 리포트"));
assert(markdown.includes("## 요약"));
assert(markdown.includes("| 읽지 않음 | 2건 |"));
assert(markdown.includes("| 마감 알림 | 꺼짐 |"));
assert(markdown.includes("| 조용한 시간 | 22:00-08:00 |"));
assert(markdown.includes("## 우선순위"));
assert(markdown.includes("| 높음 | 1건 | 1건 |"));
assert(markdown.includes("## 알림 상세"));
assert(markdown.includes("마감 임박: 창업 지원"));
assert(markdown.includes("운영팀 답변 도착"));
assert(markdown.includes("마감 알림이 꺼져"));
assert.equal(report.fallbackFilename, "cunote-notification-center-2026-06-30.md");
assert.equal(report.filename, "창업노트-알림센터-2026-06-30.md");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "notification_center_report_heading",
    "notification_center_report_summary",
    "notification_center_report_priority_summary",
    "notification_center_report_rows",
    "notification_center_report_next_actions",
    "notification_center_report_filename",
  ],
}, null, 2));
