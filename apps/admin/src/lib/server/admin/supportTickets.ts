import { getAdminSql } from "@/lib/server/db/client";
import type { AdminSession } from "@/lib/server/auth/adminSession";

export type AdminSupportTicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type AdminSupportTicketPriority = "low" | "normal" | "high" | "urgent";
export type AdminSupportTicketMessageVisibility = "public" | "internal";

export interface AdminSupportTicketUpdateResult {
  id: string;
  status: AdminSupportTicketStatus;
  priority: AdminSupportTicketPriority;
  assignedTo: string | null;
  slaDueAt: string | null;
  updatedAt: string;
}

export interface AdminSupportTicketMessageResult {
  id: string;
  ticketId: string;
  authorType: "admin";
  visibility: AdminSupportTicketMessageVisibility;
  body: string;
  createdAt: string;
}

interface TicketRow {
  id: string;
  status: string;
  priority: string;
  metadata: Record<string, unknown>;
}

interface TicketUpdateRow {
  id: string;
  status: string;
  priority: string;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  ticket_id: string;
  author_type: string;
  visibility: AdminSupportTicketMessageVisibility;
  body: string;
  created_at: Date;
}

const SUPPORT_TICKET_STATUSES: AdminSupportTicketStatus[] = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
];
const SUPPORT_TICKET_PRIORITIES: AdminSupportTicketPriority[] = ["low", "normal", "high", "urgent"];
const SUPPORT_TICKET_MESSAGE_VISIBILITIES: AdminSupportTicketMessageVisibility[] = ["public", "internal"];

export class AdminSupportTicketError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "AdminSupportTicketError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export async function updateAdminSupportTicket(input: {
  ticketId: string;
  status?: unknown;
  priority?: unknown;
  assignedTo?: unknown;
  slaDueAt?: unknown;
  note?: unknown;
  admin: AdminSession;
}): Promise<AdminSupportTicketUpdateResult> {
  const status = normalizeStatus(input.status);
  const priority = normalizePriority(input.priority);
  const assignedTo = normalizeOptionalText(input.assignedTo, 80);
  const slaDueAt = normalizeOptionalDate(input.slaDueAt);
  const note = normalizeNote(input.note);
  const sql = getAdminSql();
  const rows = await sql<TicketRow[]>`
    select id, status, priority, metadata
    from support_tickets
    where id = ${input.ticketId}
    limit 1
  `;
  const ticket = rows[0];
  if (!ticket) {
    throw new AdminSupportTicketError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const nextStatus = status ?? normalizeExistingStatus(ticket.status);
  const nextPriority = priority ?? normalizeExistingPriority(ticket.priority);
  const nextAssignedTo = assignedTo.provided ? assignedTo.value : stringValue(ticket.metadata.assignedTo);
  const nextSlaDueAt = slaDueAt.provided ? slaDueAt.value : dateString(ticket.metadata.slaDueAt);
  const now = new Date();
  const metadata = appendAdminEvent(ticket.metadata, {
    adminUserId: input.admin.user.id,
    adminEmail: input.admin.user.email,
    status: nextStatus,
    priority: nextPriority,
    assignedTo: nextAssignedTo,
    slaDueAt: nextSlaDueAt,
    note,
    at: now.toISOString(),
  });

  const updated = await sql<TicketUpdateRow[]>`
    update support_tickets
    set
      status = ${nextStatus},
      priority = ${nextPriority},
      metadata = ${JSON.stringify(metadata)}::jsonb,
      updated_at = ${now}
    where id = ${ticket.id}
    returning id, status, priority, updated_at
  `;
  const row = updated[0];
  if (!row) {
    throw new AdminSupportTicketError("support_ticket_update_failed", "지원 티켓 상태를 저장하지 못했습니다.", 500);
  }

  return {
    id: row.id,
    status: normalizeExistingStatus(row.status),
    priority: normalizeExistingPriority(row.priority),
    assignedTo: nextAssignedTo,
    slaDueAt: nextSlaDueAt,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function addAdminSupportTicketMessage(input: {
  ticketId: string;
  body: unknown;
  visibility?: unknown;
  admin: AdminSession;
}): Promise<AdminSupportTicketMessageResult> {
  const body = normalizeMessageBody(input.body);
  const visibility = normalizeMessageVisibility(input.visibility);
  const sql = getAdminSql();
  const rows = await sql<TicketRow[]>`
    select id, status, priority, metadata
    from support_tickets
    where id = ${input.ticketId}
    limit 1
  `;
  const ticket = rows[0];
  if (!ticket) {
    throw new AdminSupportTicketError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const now = new Date();
  const metadata = {
    adminUserId: input.admin.user.id,
    adminEmail: input.admin.user.email,
    adminRole: input.admin.user.role,
  };
  const inserted = await sql<MessageRow[]>`
    insert into support_ticket_messages (
      ticket_id,
      author_type,
      author_user_id,
      author_email,
      body,
      visibility,
      metadata,
      created_at
    )
    values (
      ${ticket.id},
      'admin',
      null,
      ${input.admin.user.email},
      ${body},
      ${visibility},
      ${JSON.stringify(metadata)}::jsonb,
      ${now}
    )
    returning id, ticket_id, author_type, visibility, body, created_at
  `;
  const message = inserted[0];
  if (!message || message.author_type !== "admin") {
    throw new AdminSupportTicketError("support_ticket_message_failed", "지원 티켓 메시지를 저장하지 못했습니다.", 500);
  }

  await sql`
    update support_tickets
    set
      status = ${visibility === "public" ? "waiting" : ticket.status},
      metadata = ${JSON.stringify(appendAdminMessageEvent(ticket.metadata, {
        adminUserId: input.admin.user.id,
        adminEmail: input.admin.user.email,
        visibility,
        bodyPreview: preview(body),
        at: now.toISOString(),
      }))}::jsonb,
      updated_at = ${now}
    where id = ${ticket.id}
  `;

  return {
    id: message.id,
    ticketId: message.ticket_id,
    authorType: "admin",
    visibility: message.visibility,
    body: message.body,
    createdAt: message.created_at.toISOString(),
  };
}

function normalizeStatus(value: unknown): AdminSupportTicketStatus | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && SUPPORT_TICKET_STATUSES.includes(value as AdminSupportTicketStatus)) {
    return value as AdminSupportTicketStatus;
  }
  throw new AdminSupportTicketError("invalid_support_ticket_status", "지원 티켓 상태를 확인해주세요.", 400, "status");
}

function normalizePriority(value: unknown): AdminSupportTicketPriority | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && SUPPORT_TICKET_PRIORITIES.includes(value as AdminSupportTicketPriority)) {
    return value as AdminSupportTicketPriority;
  }
  throw new AdminSupportTicketError("invalid_support_ticket_priority", "지원 티켓 우선순위를 확인해주세요.", 400, "priority");
}

function normalizeExistingStatus(value: string): AdminSupportTicketStatus {
  return SUPPORT_TICKET_STATUSES.includes(value as AdminSupportTicketStatus) ? value as AdminSupportTicketStatus : "open";
}

function normalizeExistingPriority(value: string): AdminSupportTicketPriority {
  return SUPPORT_TICKET_PRIORITIES.includes(value as AdminSupportTicketPriority) ? value as AdminSupportTicketPriority : "normal";
}

function normalizeOptionalText(value: unknown, maxLength: number): { provided: boolean; value: string | null } {
  if (value === undefined) return { provided: false, value: null };
  if (typeof value !== "string") return { provided: true, value: null };
  const trimmed = value.trim();
  return { provided: true, value: trimmed ? trimmed.slice(0, maxLength) : null };
}

function normalizeOptionalDate(value: unknown): { provided: boolean; value: string | null } {
  if (value === undefined) return { provided: false, value: null };
  if (typeof value !== "string") return { provided: true, value: null };
  const trimmed = value.trim();
  if (!trimmed) return { provided: true, value: null };
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new AdminSupportTicketError("invalid_support_ticket_sla_due_at", "SLA 날짜를 확인해주세요.", 400, "slaDueAt");
  }
  return { provided: true, value: date.toISOString().slice(0, 10) };
}

function normalizeNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function normalizeMessageBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new AdminSupportTicketError("required_field", "답변 또는 메모 내용을 입력해주세요.", 400, "body");
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    throw new AdminSupportTicketError("support_ticket_message_too_short", "답변 또는 메모는 2자 이상 입력해주세요.", 400, "body");
  }
  return trimmed.slice(0, 4000);
}

function normalizeMessageVisibility(value: unknown): AdminSupportTicketMessageVisibility {
  if (value === undefined || value === null || value === "") return "public";
  if (typeof value === "string" && SUPPORT_TICKET_MESSAGE_VISIBILITIES.includes(value as AdminSupportTicketMessageVisibility)) {
    return value as AdminSupportTicketMessageVisibility;
  }
  throw new AdminSupportTicketError("invalid_support_ticket_message_visibility", "메시지 공개 범위를 확인해주세요.", 400, "visibility");
}

function appendAdminEvent(
  metadata: Record<string, unknown>,
  event: {
    adminUserId: string;
    adminEmail: string;
    status: AdminSupportTicketStatus;
    priority: AdminSupportTicketPriority;
    assignedTo: string | null;
    slaDueAt: string | null;
    note: string | null;
    at: string;
  },
): Record<string, unknown> {
  const events = Array.isArray(metadata.adminEvents) ? metadata.adminEvents : [];
  return {
    ...metadata,
    assignedTo: event.assignedTo,
    slaDueAt: event.slaDueAt,
    adminEvents: [...events.slice(-19), event],
    lastAdminEventAt: event.at,
  };
}

function appendAdminMessageEvent(
  metadata: Record<string, unknown>,
  event: {
    adminUserId: string;
    adminEmail: string;
    visibility: AdminSupportTicketMessageVisibility;
    bodyPreview: string;
    at: string;
  },
): Record<string, unknown> {
  const events = Array.isArray(metadata.adminMessageEvents) ? metadata.adminMessageEvents : [];
  return {
    ...metadata,
    adminMessageEvents: [...events.slice(-19), event],
    ...(event.visibility === "public"
      ? { lastAdminReplyAt: event.at }
      : { lastInternalNoteAt: event.at }),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
