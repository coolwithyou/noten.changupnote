import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  listSupportTicketAttachmentsForTickets,
  type SupportTicketAttachmentItem,
} from "./supportTicketAttachments";

export type SupportTicketMessageAuthor = "user" | "admin" | "system";
export type SupportTicketMessageVisibility = "public" | "internal";

export interface SupportTicketMessageReceipt {
  id: string;
  ticketId: string;
  authorType: SupportTicketMessageAuthor;
  visibility: SupportTicketMessageVisibility;
  body: string;
  createdAt: string;
}

export type UserSupportTicketStatusAction = "resolve" | "reopen";

export interface UserSupportTicketStatusResult {
  id: string;
  status: string;
  updatedAt: string;
  message: string;
}

export interface AccountSupportTicketItem {
  id: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  responseDueAt: string | null;
  publicMessageCount: number;
  lastPublicMessageAt: string;
  lastPublicMessagePreview: string;
  attachments: SupportTicketAttachmentItem[];
  thread: AccountSupportTicketMessage[];
}

export interface AccountSupportTicketMessage {
  id: string;
  authorType: SupportTicketMessageAuthor;
  body: string;
  createdAt: string;
}

export class SupportTicketMessageError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "SupportTicketMessageError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export async function listAccountSupportTickets(input: {
  access: CompanyAccess;
  session?: WebSession | null;
  limit?: number;
}): Promise<AccountSupportTicketItem[]> {
  if (!hasDatabaseUrl()) return [];
  try {
    const db = getCunoteDb();
    const limit = Math.max(1, Math.min(20, input.limit ?? 8));
    const rows = await db
      .select()
      .from(schema.supportTickets)
      .where(accountTicketWhere(input.access, input.session))
      .orderBy(desc(schema.supportTickets.updatedAt))
      .limit(limit);

    if (rows.length === 0) return [];

    const ticketIds = rows.map((row) => row.id);
    const [messages, attachmentsByTicket] = await Promise.all([
      db
        .select({
          id: schema.supportTicketMessages.id,
          ticketId: schema.supportTicketMessages.ticketId,
          authorType: schema.supportTicketMessages.authorType,
          body: schema.supportTicketMessages.body,
          createdAt: schema.supportTicketMessages.createdAt,
        })
        .from(schema.supportTicketMessages)
        .where(and(
          inArray(schema.supportTicketMessages.ticketId, ticketIds),
          eq(schema.supportTicketMessages.visibility, "public"),
        ))
        .orderBy(desc(schema.supportTicketMessages.createdAt)),
      listSupportTicketAttachmentsForTickets({
        ticketIds,
        visibility: "public",
      }),
    ]);

    const messagesByTicket = new Map<string, AccountSupportTicketMessage[]>();
    for (const message of messages) {
      const bucket = messagesByTicket.get(message.ticketId) ?? [];
      bucket.push({
        id: message.id,
        authorType: message.authorType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      });
      messagesByTicket.set(message.ticketId, bucket);
    }

    return rows.map((row) => {
      const publicMessages = (messagesByTicket.get(row.id) ?? []).sort((a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt)
      );
      const thread: AccountSupportTicketMessage[] = [
        {
          id: `${row.id}:initial`,
          authorType: "user",
          body: row.message,
          createdAt: row.createdAt.toISOString(),
        },
        ...publicMessages,
      ];
      const latest = thread[thread.length - 1]!;
      return {
        id: row.id,
        category: row.category,
        subject: row.subject,
        status: row.status,
        priority: row.priority,
        email: row.email,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        responseDueAt: dateString(row.metadata.slaDueAt),
        publicMessageCount: thread.length,
        lastPublicMessageAt: latest.createdAt,
        lastPublicMessagePreview: preview(latest.body),
        attachments: attachmentsByTicket.get(row.id) ?? [],
        thread: thread.slice(-4),
      };
    });
  } catch {
    return [];
  }
}

export async function addUserSupportTicketMessage(input: {
  ticketId: string;
  body: unknown;
  access: CompanyAccess;
  session?: WebSession | null;
}): Promise<SupportTicketMessageReceipt> {
  if (!hasDatabaseUrl()) {
    throw new SupportTicketMessageError("support_ticket_storage_unavailable", "문의 기록 저장소가 연결되지 않았습니다.", 503);
  }
  const body = normalizeBody(input.body);
  const db = getCunoteDb();
  const [ticket] = await db
    .select()
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);

  if (!ticket || !canAccessTicket(ticket, input.access, input.session)) {
    throw new SupportTicketMessageError("support_ticket_not_found", "문의 기록을 찾지 못했습니다.", 404, "ticketId");
  }

  const now = new Date();
  const [message] = await db
    .insert(schema.supportTicketMessages)
    .values({
      ticketId: ticket.id,
      authorType: "user",
      authorUserId: uuidOrNull(input.session?.user.id ?? input.access.userId),
      authorEmail: input.session?.user.email ?? ticket.email,
      body,
      visibility: "public",
      metadata: {
        mode: input.access.mode,
        companyId: input.access.companyId,
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

  if (!message) {
    throw new SupportTicketMessageError("support_ticket_message_failed", "답장을 저장하지 못했습니다.", 500);
  }

  await db
    .update(schema.supportTickets)
    .set({
      status: nextUserReplyStatus(ticket.status),
      metadata: {
        ...ticket.metadata,
        lastUserReplyAt: now.toISOString(),
      },
      updatedAt: now,
    })
    .where(eq(schema.supportTickets.id, ticket.id));

  return toReceipt(message);
}

export async function updateUserSupportTicketStatus(input: {
  ticketId: string;
  action: unknown;
  access: CompanyAccess;
  session?: WebSession | null;
}): Promise<UserSupportTicketStatusResult> {
  if (!hasDatabaseUrl()) {
    throw new SupportTicketMessageError("support_ticket_storage_unavailable", "문의 기록 저장소가 연결되지 않았습니다.", 503);
  }
  if (!uuidOrNull(input.ticketId)) {
    throw new SupportTicketMessageError("invalid_support_ticket_id", "문의 접수번호를 확인해주세요.", 400, "ticketId");
  }
  const action = normalizeStatusAction(input.action);
  const db = getCunoteDb();
  const [ticket] = await db
    .select()
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);

  if (!ticket || !canAccessTicket(ticket, input.access, input.session)) {
    throw new SupportTicketMessageError("support_ticket_not_found", "문의 기록을 찾지 못했습니다.", 404, "ticketId");
  }

  const now = new Date();
  const status = action === "resolve" ? "resolved" : "open";
  const [updated] = await db
    .update(schema.supportTickets)
    .set({
      status,
      metadata: appendUserStatusEvent(ticket.metadata, {
        action,
        status,
        userId: input.session?.user.id ?? input.access.userId,
        at: now.toISOString(),
      }),
      updatedAt: now,
    })
    .where(eq(schema.supportTickets.id, ticket.id))
    .returning({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      updatedAt: schema.supportTickets.updatedAt,
    });

  if (!updated) {
    throw new SupportTicketMessageError("support_ticket_status_failed", "문의 상태를 저장하지 못했습니다.", 500);
  }

  return {
    id: updated.id,
    status: updated.status,
    updatedAt: updated.updatedAt.toISOString(),
    message: action === "resolve" ? "문의가 해결됨으로 표시됐습니다." : "문의를 다시 열었습니다.",
  };
}

function accountTicketWhere(access: CompanyAccess, session?: WebSession | null): SQL {
  const conditions: SQL[] = [
    eq(schema.supportTickets.companyId, access.companyId),
  ];
  const userId = uuidOrNull(session?.user.id ?? access.userId);
  if (userId) conditions.push(eq(schema.supportTickets.userId, userId));
  const email = session?.user.email?.trim();
  if (email) conditions.push(eq(schema.supportTickets.email, email));
  return or(...conditions)!;
}

function canAccessTicket(
  ticket: typeof schema.supportTickets.$inferSelect,
  access: CompanyAccess,
  session?: WebSession | null,
): boolean {
  if (ticket.companyId && ticket.companyId === access.companyId) return true;
  if (ticket.userId && ticket.userId === (session?.user.id ?? access.userId)) return true;
  const sessionEmail = session?.user.email?.trim().toLowerCase();
  return Boolean(sessionEmail && ticket.email.trim().toLowerCase() === sessionEmail);
}

function nextUserReplyStatus(status: string): string {
  if (status === "resolved" || status === "closed" || status === "waiting") return "open";
  return status;
}

function normalizeStatusAction(value: unknown): UserSupportTicketStatusAction {
  if (value === "resolve" || value === "reopen") return value;
  throw new SupportTicketMessageError("invalid_support_ticket_status_action", "문의 상태 변경 동작을 확인해주세요.", 400, "action");
}

function appendUserStatusEvent(
  metadata: Record<string, unknown>,
  event: {
    action: UserSupportTicketStatusAction;
    status: string;
    userId: string;
    at: string;
  },
): Record<string, unknown> {
  const events = Array.isArray(metadata.userStatusEvents)
    ? metadata.userStatusEvents.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item))
    )
    : [];
  return {
    ...metadata,
    lastUserStatusAction: event.action,
    lastUserStatusAt: event.at,
    userStatusEvents: [...events, event].slice(-20),
  };
}

function normalizeBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new SupportTicketMessageError("required_field", "답장 내용을 입력해주세요.", 400, "body");
  }
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    throw new SupportTicketMessageError("message_too_short", "답장 내용을 2자 이상 입력해주세요.", 400, "body");
  }
  return trimmed.slice(0, 4000);
}

function preview(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toReceipt(row: {
  id: string;
  ticketId: string;
  authorType: SupportTicketMessageAuthor;
  visibility: SupportTicketMessageVisibility;
  body: string;
  createdAt: Date;
}): SupportTicketMessageReceipt {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorType: row.authorType,
    visibility: row.visibility,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
