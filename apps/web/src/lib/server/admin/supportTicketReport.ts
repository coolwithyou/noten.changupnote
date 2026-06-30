import type { AdminSupportTicketItem } from "./flywheelStore";

export function renderAdminSupportTicketReport(input: {
  tickets: AdminSupportTicketItem[];
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const summary = summarizeSupportTickets(input.tickets);
  const lines = [
    "# 창업노트 고객지원 운영 큐",
    "",
    `- 생성 시각: ${formatDateTime(generatedAt)}`,
    `- 최근 티켓: ${input.tickets.length.toLocaleString("ko-KR")}건`,
    `- SLA 초과: ${summary.overdue.toLocaleString("ko-KR")}건`,
    `- SLA 임박: ${summary.dueSoon.toLocaleString("ko-KR")}건`,
    `- 미지정 담당: ${summary.unassigned.toLocaleString("ko-KR")}건`,
    "",
    "## SLA 요약",
    "",
    markdownTable(
      ["상태", "건수"],
      [
        ["SLA 초과", String(summary.overdue)],
        ["SLA 임박", String(summary.dueSoon)],
        ["정상", String(summary.ok)],
        ["SLA 없음", String(summary.none)],
      ],
    ),
    "",
    "## 상태/우선순위 요약",
    "",
    markdownTable(
      ["구분", "건수"],
      [
        ...countRows("상태", summary.byStatus),
        ...countRows("우선순위", summary.byPriority),
      ],
    ),
    "",
    "## 최근 티켓",
    "",
    renderTicketRows(input.tickets),
    "",
    "## 운영 액션",
    "",
    ...nextActions(summary),
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function summarizeSupportTickets(tickets: AdminSupportTicketItem[]) {
  const byStatus = new Map<string, number>();
  const byPriority = new Map<string, number>();
  let overdue = 0;
  let dueSoon = 0;
  let ok = 0;
  let none = 0;
  let unassigned = 0;

  for (const ticket of tickets) {
    increment(byStatus, statusLabel(ticket.status));
    increment(byPriority, priorityLabel(ticket.priority));
    if (!ticket.assignedTo) unassigned += 1;
    if (ticket.slaStatus === "overdue") overdue += 1;
    else if (ticket.slaStatus === "due_soon") dueSoon += 1;
    else if (ticket.slaStatus === "ok") ok += 1;
    else none += 1;
  }

  return { byStatus, byPriority, overdue, dueSoon, ok, none, unassigned };
}

function renderTicketRows(tickets: AdminSupportTicketItem[]): string {
  if (tickets.length === 0) return "최근 고객지원 티켓이 없습니다.";
  return markdownTable(
    ["상태", "SLA", "우선순위", "담당", "제목", "최근 메시지/첨부"],
    tickets.map((ticket) => [
      statusLabel(ticket.status),
      slaLabel(ticket.slaStatus, ticket.slaDueAt),
      priorityLabel(ticket.priority),
      ticket.assignedTo ?? "미지정",
      ticket.subject,
      [
        ticket.lastMessagePreview ? `메시지: ${ticket.lastMessagePreview}` : "메시지 없음",
        ticket.attachmentCount > 0 ? `첨부 ${ticket.attachmentCount}개: ${ticket.lastAttachmentFilename ?? "파일명 없음"}` : null,
      ].filter(Boolean).join("<br>"),
    ]),
  );
}

function nextActions(summary: ReturnType<typeof summarizeSupportTickets>): string[] {
  const actions: string[] = [];
  if (summary.overdue > 0) actions.push("- SLA 초과 티켓은 우선 담당자를 지정하고 상태를 처리중으로 갱신한다.");
  if (summary.dueSoon > 0) actions.push("- SLA 임박 티켓은 공개 답변 또는 내부 메모를 남겨 다음 처리 시점을 명확히 한다.");
  if (summary.unassigned > 0) actions.push("- 담당자 미지정 티켓은 운영 담당자를 배정한다.");
  if (actions.length === 0) {
    actions.push("- 새 문의가 접수되면 담당자와 SLA 기준일을 먼저 지정한다.");
  }
  actions.push("- 공개 답변은 사용자 계정 화면과 알림센터에 노출되므로 내부 메모와 구분해 작성한다.");
  return actions;
}

function countRows(label: string, counts: Map<string, number>): string[][] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))
    .map(([key, value]) => [`${label}: ${key}`, String(value)]);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "사용자 답변 대기";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function priorityLabel(priority: string): string {
  if (priority === "urgent") return "긴급";
  if (priority === "high") return "높음";
  if (priority === "low") return "낮음";
  return "보통";
}

function slaLabel(status: AdminSupportTicketItem["slaStatus"], dueAt: string | null): string {
  const due = dueAt ?? "미설정";
  if (status === "overdue") return `초과 · ${due}`;
  if (status === "due_soon") return `임박 · ${due}`;
  if (status === "ok") return `정상 · ${due}`;
  return "없음";
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(value);
}
