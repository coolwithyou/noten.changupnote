import { and, desc, eq } from "drizzle-orm";
import type { AdminAccess } from "@/lib/server/auth/adminGuard";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export interface SupportTicketEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface SupportTicketEmailHandoffTicket {
  id: string;
  email: string;
  name: string | null;
  subject: string;
  category: string;
  message: string;
  createdAt: string;
}

export interface SupportTicketEmailHandoffMessage {
  body: string;
  createdAt: string;
}

export class SupportTicketEmailHandoffError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SupportTicketEmailHandoffError";
  }
}

export async function buildSupportTicketEmailHandoff(input: {
  ticketId: string;
  admin: AdminAccess;
  asOf?: Date;
}): Promise<SupportTicketEmailHandoff> {
  if (!hasDatabaseUrl()) {
    throw new SupportTicketEmailHandoffError("support_ticket_storage_unavailable", "문의 기록 저장소가 연결되지 않았습니다.", 503);
  }

  const db = getCunoteDb();
  const [ticket] = await db
    .select({
      id: schema.supportTickets.id,
      email: schema.supportTickets.email,
      name: schema.supportTickets.name,
      subject: schema.supportTickets.subject,
      category: schema.supportTickets.category,
      message: schema.supportTickets.message,
      createdAt: schema.supportTickets.createdAt,
    })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);

  if (!ticket) {
    throw new SupportTicketEmailHandoffError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const [message] = await db
    .select({
      body: schema.supportTicketMessages.body,
      createdAt: schema.supportTicketMessages.createdAt,
    })
    .from(schema.supportTicketMessages)
    .where(and(
      eq(schema.supportTicketMessages.ticketId, ticket.id),
      eq(schema.supportTicketMessages.authorType, "admin"),
      eq(schema.supportTicketMessages.visibility, "public"),
    ))
    .orderBy(desc(schema.supportTicketMessages.createdAt))
    .limit(1);

  return renderSupportTicketEmailHandoff({
    ticket: {
      id: ticket.id,
      email: ticket.email,
      name: ticket.name,
      subject: ticket.subject,
      category: ticket.category,
      message: ticket.message,
      createdAt: ticket.createdAt.toISOString(),
    },
    message: message
      ? {
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      }
      : null,
    admin: input.admin,
    generatedAt: input.asOf ?? new Date(),
  });
}

export function renderSupportTicketEmailHandoff(input: {
  ticket: SupportTicketEmailHandoffTicket;
  message: SupportTicketEmailHandoffMessage | null;
  admin: Pick<AdminAccess, "userId" | "mode">;
  generatedAt?: Date;
}): SupportTicketEmailHandoff {
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(input.ticket.subject, "고객지원-답변");
  const body = input.message?.body?.trim() || fallbackReplyBody(input.ticket);
  const subject = `Re: ${input.ticket.subject}`;
  const eml = renderEml({
    from: supportFromAddress(),
    to: input.ticket.email,
    subject,
    date: generatedAt,
    body: [
      body,
      "",
      "-- ",
      "창업노트 고객지원",
      "",
      "----- 원문 문의 -----",
      `접수번호: ${input.ticket.id}`,
      `유형: ${input.ticket.category}`,
      `접수일: ${formatDateTime(new Date(input.ticket.createdAt))}`,
      `운영자: ${input.admin.userId} (${input.admin.mode})`,
      "",
      input.ticket.message.trim(),
      "",
    ].join("\n"),
  });

  return {
    filename: `창업노트-${filenameBase}-이메일답변.eml`,
    fallbackFilename: `cunote-support-reply-${input.ticket.id.slice(0, 8)}.eml`,
    eml,
  };
}

export function supportTicketEmailHandoffDownloadResponse(handoff: SupportTicketEmailHandoff): Response {
  return textDownloadResponse({
    body: handoff.eml,
    filename: handoff.filename,
    fallbackFilename: handoff.fallbackFilename,
    contentType: "message/rfc822; charset=utf-8",
  });
}

function renderEml(input: {
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${formatAddress(input.to)}`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: support-ticket-email",
  ];
  return `${[...headers, "", normalizeEmailBody(input.body)].join("\r\n")}\r\n`;
}

function fallbackReplyBody(ticket: SupportTicketEmailHandoffTicket): string {
  return [
    `${ticket.name ?? "고객"}님, 안녕하세요.`,
    "",
    "문의 내용을 확인했습니다. 담당자가 검토한 뒤 이 메일 스레드로 후속 답변을 드리겠습니다.",
  ].join("\n");
}

function supportFromAddress(): string {
  const email = process.env.CUNOTE_SUPPORT_EMAIL?.trim() || "support@changupnote.com";
  return `=?UTF-8?B?${Buffer.from("창업노트 고객지원", "utf8").toString("base64")}?= <${email}>`;
}

function formatAddress(email: string): string {
  return `<${email.trim()}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function normalizeEmailBody(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
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

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
