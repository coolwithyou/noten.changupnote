import assert from "node:assert/strict";
import type { AdminSupportTicketItem } from "./flywheelStore";
import { renderAdminSupportTicketReport } from "./supportTicketReport";

const tickets: AdminSupportTicketItem[] = [
  ticket({
    id: "11111111-1111-4111-8111-111111111111",
    subject: "로그인 후 매칭 결과가 보이지 않습니다",
    status: "open",
    priority: "urgent",
    assignedTo: null,
    slaDueAt: "2026-06-29",
    slaStatus: "overdue",
    lastMessagePreview: "확인 중입니다.",
    attachmentCount: 1,
    lastAttachmentFilename: "screen.png",
  }),
  ticket({
    id: "22222222-2222-4222-8222-222222222222",
    subject: "청구 담당자 변경 요청",
    status: "in_progress",
    priority: "normal",
    assignedTo: "ops",
    slaDueAt: "2026-07-01",
    slaStatus: "due_soon",
  }),
];

const markdown = renderAdminSupportTicketReport({
  tickets,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});

assert(markdown.includes("# 창업노트 고객지원 운영 큐"));
assert(markdown.includes("SLA 초과: 1건"));
assert(markdown.includes("미지정 담당: 1건"));
assert(markdown.includes("## SLA 요약"));
assert(markdown.includes("| 상태 | SLA | 우선순위 | 담당 | 제목 | 최근 메시지/첨부 |"));
assert(markdown.includes("로그인 후 매칭 결과가 보이지 않습니다"));
assert(markdown.includes("첨부 1개: screen.png"));
assert(markdown.includes("SLA 초과 티켓은 우선 담당자를 지정"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "admin_support_ticket_report_heading",
    "admin_support_ticket_report_sla_summary",
    "admin_support_ticket_report_status_priority_summary",
    "admin_support_ticket_report_ticket_rows",
    "admin_support_ticket_report_next_actions",
  ],
}, null, 2));

function ticket(input: Partial<AdminSupportTicketItem> & Pick<AdminSupportTicketItem, "id" | "subject" | "status" | "priority" | "assignedTo" | "slaDueAt" | "slaStatus">): AdminSupportTicketItem {
  return {
    id: input.id,
    category: input.category ?? "product",
    subject: input.subject,
    messagePreview: input.messagePreview ?? "문의 본문",
    status: input.status,
    priority: input.priority,
    email: input.email ?? "user@example.test",
    createdAt: input.createdAt ?? "2026-06-28T00:00:00.000Z",
    assignedTo: input.assignedTo,
    slaDueAt: input.slaDueAt,
    slaStatus: input.slaStatus,
    messageCount: input.messageCount ?? 1,
    lastMessageAt: input.lastMessageAt ?? null,
    lastMessagePreview: input.lastMessagePreview ?? null,
    lastMessageVisibility: input.lastMessageVisibility ?? null,
    attachmentCount: input.attachmentCount ?? 0,
    lastAttachmentFilename: input.lastAttachmentFilename ?? null,
    lastAttachmentUrl: input.lastAttachmentUrl ?? null,
  };
}
