import { getAdminSql } from "@/lib/server/db/client";
import type { AdminSession } from "@/lib/server/auth/adminSession";

export interface SupportTicketEmailHandoff {
  filename: string;
  eml: string;
}

interface TicketRow {
  id: string;
  email: string;
  name: string | null;
  subject: string;
  category: string;
  message: string;
}

interface MessageRow {
  body: string;
  created_at: Date;
}

export class SupportTicketEmailHandoffError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "SupportTicketEmailHandoffError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export async function buildSupportTicketEmailHandoff(input: {
  ticketId: string;
  admin: AdminSession;
}): Promise<SupportTicketEmailHandoff> {
  const sql = getAdminSql();
  const tickets = await sql<TicketRow[]>`
    select id, email, name, subject, category, message
    from support_tickets
    where id = ${input.ticketId}
    limit 1
  `;
  const ticket = tickets[0];
  if (!ticket) {
    throw new SupportTicketEmailHandoffError("support_ticket_not_found", "지원 티켓을 찾지 못했습니다.", 404, "ticketId");
  }

  const messages = await sql<MessageRow[]>`
    select body, created_at
    from support_ticket_messages
    where ticket_id = ${ticket.id}
      and author_type = 'admin'
      and visibility = 'public'
    order by created_at desc
    limit 1
  `;
  const latestReply = messages[0];
  if (!latestReply) {
    throw new SupportTicketEmailHandoffError(
      "support_ticket_public_reply_missing",
      "이메일로 전달할 공개 답변이 없습니다.",
      409,
      "ticketId",
    );
  }

  const subject = `Re: ${ticket.subject}`;
  const body = [
    latestReply.body,
    "",
    "---",
    `티켓: ${ticket.id}`,
    `카테고리: ${ticket.category}`,
    `수신자: ${ticket.name ?? ticket.email} <${ticket.email}>`,
    `운영자: ${input.admin.user.email} (${input.admin.user.role})`,
    `답변 작성: ${latestReply.created_at.toISOString()}`,
    "",
    "원문 문의:",
    ticket.message,
    "",
  ].join("\r\n");

  return {
    filename: `cunote-support-${ticket.id}.eml`,
    eml: renderEml({
      from: `창업노트 <${process.env.CUNOTE_SUPPORT_EMAIL ?? "support@changupnote.com"}>`,
      to: `${ticket.name ?? ticket.email} <${ticket.email}>`,
      subject,
      body,
    }),
  };
}

export function supportTicketEmailHandoffDownloadResponse(handoff: SupportTicketEmailHandoff): Response {
  const encoded = encodeURIComponent(handoff.filename);
  return new Response(handoff.eml, {
    headers: {
      "Content-Type": "message/rfc822; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
    },
  });
}

function renderEml(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  return [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ].join("\r\n");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value: string): string {
  const sanitized = sanitizeHeader(value);
  return /^[\x00-\x7F]*$/.test(sanitized)
    ? sanitized
    : `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}
