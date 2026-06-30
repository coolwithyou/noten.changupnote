import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import type { NotificationCenterItem, NotificationCenterResult } from "@/lib/notifications/types";

export interface NotificationCenterReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export function buildNotificationCenterReport(input: {
  center: NotificationCenterResult;
  generatedAt?: Date;
}): NotificationCenterReport {
  const generatedAt = input.generatedAt ?? new Date(input.center.generatedAt);
  const stamp = dateStamp(generatedAt);
  return {
    filename: `창업노트-알림센터-${stamp}.md`,
    fallbackFilename: `cunote-notification-center-${stamp}.md`,
    markdown: renderNotificationCenterReport({
      center: input.center,
      generatedAt,
    }),
  };
}

export function notificationCenterReportDownloadResponse(report: NotificationCenterReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

export function renderNotificationCenterReport(input: {
  center: NotificationCenterResult;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date(input.center.generatedAt);
  const { center } = input;
  const lines = [
    "# 창업노트 알림센터 리포트",
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    `피드 기준 시각: ${formatDateTime(new Date(center.generatedAt))}`,
    "",
    "> 창업노트 알림센터의 현재 마감, 신청 리마인더, 고객지원 입력 필요 항목을 운영 점검용으로 내려받은 문서입니다.",
    "",
    "## 요약",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["표시 알림", `${center.notifications.length.toLocaleString("ko-KR")}건`],
        ["읽지 않음", `${center.unreadCount.toLocaleString("ko-KR")}건`],
        ["숨김", `${center.dismissedCount.toLocaleString("ko-KR")}건`],
        ["마감 알림", center.settings.deadlineReminder ? "켜짐" : "꺼짐"],
        ["새 매칭 알림", center.settings.newMatch ? "켜짐" : "꺼짐"],
        ["조용한 시간", quietHoursLabel(center.settings.quietHoursStart, center.settings.quietHoursEnd)],
      ],
    ),
    "",
    "## 우선순위",
    "",
    renderPrioritySummary(center.notifications),
    "",
    "## 알림 상세",
    "",
    renderNotificationRows(center.notifications),
    "",
    "## 운영 액션",
    "",
    ...nextActions(center),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderPrioritySummary(items: NotificationCenterItem[]): string {
  return markdownTable(
    ["우선순위", "읽지 않음", "전체"],
    (["high", "medium", "low"] as const).map((priority) => {
      const matching = items.filter((item) => item.priority === priority);
      return [
        priorityLabel(priority),
        `${matching.filter((item) => item.status === "unread").length.toLocaleString("ko-KR")}건`,
        `${matching.length.toLocaleString("ko-KR")}건`,
      ];
    }),
  );
}

function renderNotificationRows(items: NotificationCenterItem[]): string {
  if (items.length === 0) return "_현재 표시할 알림이 없습니다._";
  return markdownTable(
    ["상태", "종류", "우선순위", "제목", "일정", "대상", "규칙"],
    items.map((item) => [
      statusLabel(item.status),
      kindLabel(item.kind),
      priorityLabel(item.priority),
      item.title,
      item.dDay !== undefined && item.dDay !== null
        ? `${dDayLabel(item.dDay)}${item.etaDate ? ` · ${item.etaDate}` : ""}`
        : item.etaDate ?? "-",
      item.href,
      item.rulesetVer,
    ]),
  );
}

function nextActions(center: NotificationCenterResult): string[] {
  const actions: string[] = [];
  const unreadHigh = center.notifications.filter((item) => item.status === "unread" && item.priority === "high");
  if (unreadHigh.length > 0) {
    actions.push(`- 높은 우선순위 미확인 알림 ${unreadHigh.length.toLocaleString("ko-KR")}건을 먼저 처리한다.`);
  }
  if (!center.settings.deadlineReminder) {
    actions.push("- 마감 알림이 꺼져 있어 신청 일정 누락 위험이 없는지 확인한다.");
  }
  if (!center.settings.newMatch) {
    actions.push("- 새 매칭 알림이 꺼져 있어 신규 적격 공고 확인 흐름을 대체할 운영 루틴을 둔다.");
  }
  if (center.notifications.some((item) => item.kind === "needs_input")) {
    actions.push("- 입력 필요 알림은 `/account` 또는 `/applications`에서 상태를 닫아 다음 리포트에서 사라지게 한다.");
  }
  if (actions.length === 0) {
    actions.push("- 새 알림이 생기면 읽음 또는 숨김 처리로 사용자별 처리 상태를 남긴다.");
  }
  return actions;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function kindLabel(kind: NotificationCenterItem["kind"]): string {
  if (kind === "deadline") return "마감";
  if (kind === "new_match") return "신규 적격";
  if (kind === "soon_eligible") return "곧 적격";
  return "입력 필요";
}

function priorityLabel(priority: NotificationCenterItem["priority"]): string {
  if (priority === "high") return "높음";
  if (priority === "medium") return "중간";
  return "낮음";
}

function statusLabel(status: NotificationCenterItem["status"]): string {
  if (status === "read") return "읽음";
  if (status === "dismissed") return "숨김";
  return "읽지 않음";
}

function dDayLabel(dDay: number): string {
  if (dDay < 0) return `${Math.abs(dDay)}일 지남`;
  if (dDay === 0) return "오늘";
  return `D-${dDay}`;
}

function quietHoursLabel(start: string | null, end: string | null): string {
  if (!start || !end) return "미설정";
  return `${start}-${end}`;
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}
