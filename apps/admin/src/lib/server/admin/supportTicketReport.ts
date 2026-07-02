import { getAdminSql } from "@/lib/server/db/client";

export interface AdminSupportTicketReportItem {
  id: string;
  category: string;
  subject: string;
  messagePreview: string;
  status: string;
  priority: string;
  email: string;
  createdAt: string;
  assignedTo: string | null;
  slaDueAt: string | null;
  slaStatus: "none" | "due_soon" | "overdue" | "ok";
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageVisibility: "public" | "internal" | null;
  attachmentCount: number;
  lastAttachmentFilename: string | null;
  lastAttachmentUrl: string | null;
}

interface SupportTicketReportRow {
  id: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  priority: string;
  email: string;
  created_at: Date;
  metadata: Record<string, unknown>;
  message_count: number;
  last_message_at: Date | null;
  last_message_preview: string | null;
  last_message_visibility: string | null;
  attachment_count: number;
  last_attachment_filename: string | null;
  last_attachment_url: string | null;
}

export async function listAdminSupportTicketReportItems(limit = 50): Promise<AdminSupportTicketReportItem[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const sql = getAdminSql();
  const rows = await sql<SupportTicketReportRow[]>`
    select
      ticket.id,
      ticket.category,
      ticket.subject,
      ticket.message,
      ticket.status,
      ticket.priority,
      ticket.email,
      ticket.created_at,
      ticket.metadata,
      coalesce(message_counts.message_count, 0)::int as message_count,
      latest_message.created_at as last_message_at,
      latest_message.body as last_message_preview,
      latest_message.visibility as last_message_visibility,
      coalesce(attachment_counts.attachment_count, 0)::int as attachment_count,
      latest_attachment.filename as last_attachment_filename,
      latest_attachment.archive_url as last_attachment_url
    from support_tickets ticket
    left join lateral (
      select count(*)::int as message_count
      from support_ticket_messages message
      where message.ticket_id = ticket.id
    ) message_counts on true
    left join lateral (
      select message.created_at, message.body, message.visibility
      from support_ticket_messages message
      where message.ticket_id = ticket.id
      order by message.created_at desc
      limit 1
    ) latest_message on true
    left join lateral (
      select count(*)::int as attachment_count
      from support_ticket_attachments attachment
      where attachment.ticket_id = ticket.id and attachment.status = 'active'
    ) attachment_counts on true
    left join lateral (
      select attachment.filename, attachment.archive_url
      from support_ticket_attachments attachment
      where attachment.ticket_id = ticket.id and attachment.status = 'active'
      order by attachment.created_at desc
      limit 1
    ) latest_attachment on true
    order by ticket.created_at desc
    limit ${safeLimit}
  `;

  return rows.map((row) => {
    const slaDueAt = dateString(row.metadata.slaDueAt);
    return {
      id: row.id,
      category: row.category,
      subject: row.subject,
      messagePreview: preview(row.message),
      status: row.status,
      priority: row.priority,
      email: row.email,
      createdAt: row.created_at.toISOString(),
      assignedTo: stringValue(row.metadata.assignedTo),
      slaDueAt,
      slaStatus: slaStatus(slaDueAt),
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      lastMessagePreview: row.last_message_preview ? preview(row.last_message_preview) : null,
      lastMessageVisibility: normalizeVisibility(row.last_message_visibility),
      attachmentCount: row.attachment_count,
      lastAttachmentFilename: row.last_attachment_filename,
      lastAttachmentUrl: row.last_attachment_url,
    };
  });
}

export function renderAdminSupportTicketReport(input: {
  tickets: AdminSupportTicketReportItem[];
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

function summarizeSupportTickets(tickets: AdminSupportTicketReportItem[]) {
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

function renderTicketRows(tickets: AdminSupportTicketReportItem[]): string {
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

function slaLabel(status: AdminSupportTicketReportItem["slaStatus"], dueAt: string | null): string {
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

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function slaStatus(value: string | null): "none" | "due_soon" | "overdue" | "ok" {
  if (!value) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(value);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 1) return "due_soon";
  return "ok";
}

function normalizeVisibility(value: string | null): "public" | "internal" | null {
  return value === "public" || value === "internal" ? value : null;
}
