import { eq } from "drizzle-orm";
import type { AdminAccess } from "@/lib/server/auth/adminGuard";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export type AdminSupportTicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type AdminSupportTicketPriority = "low" | "normal" | "high" | "urgent";
export type AdminSupportTicketMessageVisibility = "public" | "internal";

export interface UpdateSupportTicketInput {
  ticketId: string;
  status?: unknown;
  priority?: unknown;
  assignedTo?: unknown;
  slaDueAt?: unknown;
  note?: unknown;
  admin: AdminAccess;
}

export interface AdminSupportTicketUpdateResult {
  id: string;
  status: AdminSupportTicketStatus;
  priority: AdminSupportTicketPriority;
  assignedTo: string | null;
  slaDueAt: string | null;
  updatedAt: string;
}

export interface AddAdminSupportTicketMessageInput {
  ticketId: string;
  body: unknown;
  visibility?: unknown;
  admin: AdminAccess;
}

export interface AdminSupportTicketMessageResult {
  id: string;
  ticketId: string;
  authorType: "admin";
  visibility: AdminSupportTicketMessageVisibility;
  body: string;
  createdAt: string;
}

const SUPPORT_TICKET_STATUSES: AdminSupportTicketStatus[] = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
];
const SUPPORT_TICKET_PRIORITIES: AdminSupportTicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];
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

export async function updateAdminSupportTicket(
  input: UpdateSupportTicketInput,
): Promise<AdminSupportTicketUpdateResult> {
  const status = normalizeStatus(input.status);
  const priority = normalizePriority(input.priority);
  const assignedTo = normalizeOptionalText(input.assignedTo, 80);
  const slaDueAt = normalizeOptionalDate(input.slaDueAt);
  const note = normalizeNote(input.note);
  const db = getCunoteDb();
  const [ticket] = await db
    .select({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      priority: schema.supportTickets.priority,
      metadata: schema.supportTickets.metadata,
    })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);

  if (!ticket) {
    throw new AdminSupportTicketError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const nextStatus = status ?? normalizeExistingStatus(ticket.status);
  const nextPriority = priority ?? normalizeExistingPriority(ticket.priority);
  const nextAssignedTo = assignedTo.provided ? assignedTo.value : stringValue(ticket.metadata.assignedTo);
  const nextSlaDueAt = slaDueAt.provided ? slaDueAt.value : dateString(ticket.metadata.slaDueAt);
  const now = new Date();
  const [updated] = await db
    .update(schema.supportTickets)
    .set({
      status: nextStatus,
      priority: nextPriority,
      metadata: appendAdminEvent(ticket.metadata, {
        adminUserId: input.admin.userId,
        status: nextStatus,
        priority: nextPriority,
        assignedTo: nextAssignedTo,
        slaDueAt: nextSlaDueAt,
        note,
        at: now.toISOString(),
      }),
      updatedAt: now,
    })
    .where(eq(schema.supportTickets.id, ticket.id))
    .returning({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      priority: schema.supportTickets.priority,
      updatedAt: schema.supportTickets.updatedAt,
    });

  if (!updated) {
    throw new AdminSupportTicketError("support_ticket_update_failed", "지원 티켓 상태를 저장하지 못했습니다.", 500);
  }

  return {
    id: updated.id,
    status: normalizeExistingStatus(updated.status),
    priority: normalizeExistingPriority(updated.priority),
    assignedTo: nextAssignedTo,
    slaDueAt: nextSlaDueAt,
    updatedAt: updated.updatedAt.toISOString(),
  };
}

export async function addAdminSupportTicketMessage(
  input: AddAdminSupportTicketMessageInput,
): Promise<AdminSupportTicketMessageResult> {
  const body = normalizeMessageBody(input.body);
  const visibility = normalizeMessageVisibility(input.visibility);
  const db = getCunoteDb();
  const [ticket] = await db
    .select({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      metadata: schema.supportTickets.metadata,
    })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);

  if (!ticket) {
    throw new AdminSupportTicketError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const now = new Date();
  const [message] = await db
    .insert(schema.supportTicketMessages)
    .values({
      ticketId: ticket.id,
      authorType: "admin",
      authorUserId: uuidOrNull(input.admin.userId),
      authorEmail: null,
      body,
      visibility,
      metadata: {
        adminUserId: input.admin.userId,
        adminMode: input.admin.mode,
      },
      createdAt: now,
    })
    .returning({
      id: schema.supportTicketMessages.id,
      ticketId: schema.supportTicketMessages.ticketId,
      authorType: schema.supportTicketMessages.authorType,
      visibility: schema.supportTicketMessages.visibility,
      body: schema.supportTicketMessages.body,
      createdAt: schema.supportTicketMessages.createdAt,
    });

  if (!message || message.authorType !== "admin") {
    throw new AdminSupportTicketError("support_ticket_message_failed", "지원 티켓 메시지를 저장하지 못했습니다.", 500);
  }

  await db
    .update(schema.supportTickets)
    .set({
      status: visibility === "public" ? "waiting" : ticket.status,
      metadata: appendAdminMessageEvent(ticket.metadata, {
        adminUserId: input.admin.userId,
        visibility,
        bodyPreview: preview(body),
        at: now.toISOString(),
      }),
      updatedAt: now,
    })
    .where(eq(schema.supportTickets.id, ticket.id));

  return {
    id: message.id,
    ticketId: message.ticketId,
    authorType: "admin",
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

export function isAdminSupportTicketStatus(value: unknown): value is AdminSupportTicketStatus {
  return typeof value === "string" && SUPPORT_TICKET_STATUSES.includes(value as AdminSupportTicketStatus);
}

export function isAdminSupportTicketPriority(value: unknown): value is AdminSupportTicketPriority {
  return typeof value === "string" && SUPPORT_TICKET_PRIORITIES.includes(value as AdminSupportTicketPriority);
}

export function isAdminSupportTicketMessageVisibility(
  value: unknown,
): value is AdminSupportTicketMessageVisibility {
  return typeof value === "string"
    && SUPPORT_TICKET_MESSAGE_VISIBILITIES.includes(value as AdminSupportTicketMessageVisibility);
}

function normalizeStatus(value: unknown): AdminSupportTicketStatus | null {
  if (value === undefined || value === null || value === "") return null;
  if (isAdminSupportTicketStatus(value)) return value;
  throw new AdminSupportTicketError("invalid_support_ticket_status", "지원 티켓 상태를 확인해주세요.", 400, "status");
}

function normalizePriority(value: unknown): AdminSupportTicketPriority | null {
  if (value === undefined || value === null || value === "") return null;
  if (isAdminSupportTicketPriority(value)) return value;
  throw new AdminSupportTicketError("invalid_support_ticket_priority", "지원 티켓 우선순위를 확인해주세요.", 400, "priority");
}

function normalizeExistingStatus(value: string): AdminSupportTicketStatus {
  return isAdminSupportTicketStatus(value) ? value : "open";
}

function normalizeExistingPriority(value: string): AdminSupportTicketPriority {
  return isAdminSupportTicketPriority(value) ? value : "normal";
}

function normalizeNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
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
  if (isAdminSupportTicketMessageVisibility(value)) return value;
  throw new AdminSupportTicketError("invalid_support_ticket_message_visibility", "메시지 공개 범위를 확인해주세요.", 400, "visibility");
}

function appendAdminEvent(
  metadata: Record<string, unknown>,
  event: {
    adminUserId: string;
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

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
