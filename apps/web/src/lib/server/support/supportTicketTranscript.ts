import { and, asc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import {
  listSupportTicketAttachmentsForTicket,
  type SupportTicketAttachmentItem,
} from "./supportTicketAttachments";
import type { SupportTicketMessageAuthor } from "./supportTicketMessages";

export interface SupportTicketTranscript {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export interface SupportTicketTranscriptMessage {
  id: string;
  authorType: SupportTicketMessageAuthor;
  body: string;
  createdAt: string;
}

type TranscriptAttachment = SupportTicketAttachmentItem;

export interface SupportTicketTranscriptRenderInput {
  ticket: {
    id: string;
    category: string;
    subject: string;
    status: string;
    priority: string;
    email: string;
    createdAt: string;
    updatedAt: string;
    responseDueAt: string | null;
  };
  attachments: TranscriptAttachment[];
  thread: SupportTicketTranscriptMessage[];
  generatedAt: Date;
}

export class SupportTicketTranscriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SupportTicketTranscriptError";
  }
}

export async function buildSupportTicketTranscript(input: {
  ticketId: string;
  access: CompanyAccess;
  session?: WebSession | null;
  asOf?: Date;
}): Promise<SupportTicketTranscript> {
  if (!hasDatabaseUrl()) {
    throw new SupportTicketTranscriptError("support_ticket_storage_unavailable", "문의 기록 저장소가 연결되지 않았습니다.", 503);
  }

  try {
    const db = getCunoteDb();
    const [ticket] = await db
      .select()
      .from(schema.supportTickets)
      .where(eq(schema.supportTickets.id, input.ticketId))
      .limit(1);
    if (!ticket || !canAccessTicket(ticket, input.access, input.session)) {
      throw new SupportTicketTranscriptError("support_ticket_not_found", "문의 기록을 찾지 못했습니다.", 404, "ticketId");
    }

    const [messages, attachments] = await Promise.all([
      db
        .select({
          id: schema.supportTicketMessages.id,
          authorType: schema.supportTicketMessages.authorType,
          body: schema.supportTicketMessages.body,
          createdAt: schema.supportTicketMessages.createdAt,
        })
        .from(schema.supportTicketMessages)
        .where(and(
          eq(schema.supportTicketMessages.ticketId, ticket.id),
          eq(schema.supportTicketMessages.visibility, "public"),
        ))
        .orderBy(asc(schema.supportTicketMessages.createdAt)),
      listSupportTicketAttachmentsForTicket({
        ticketId: ticket.id,
        visibility: "public",
      }),
    ]);

    const thread: SupportTicketTranscriptMessage[] = [
      {
        id: `${ticket.id}:initial`,
        authorType: "user",
        body: ticket.message,
        createdAt: ticket.createdAt.toISOString(),
      },
      ...messages.map((message) => ({
        id: message.id,
        authorType: message.authorType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    ];
    const filenameBase = sanitizeDownloadFilename(ticket.subject, "고객지원-문의");

    return {
      filename: `창업노트-${filenameBase}-문의기록.md`,
      fallbackFilename: `cunote-support-ticket-${ticket.id.slice(0, 8)}.md`,
      markdown: renderSupportTicketTranscript({
        ticket: {
          id: ticket.id,
          category: ticket.category,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          email: ticket.email,
          createdAt: ticket.createdAt.toISOString(),
          updatedAt: ticket.updatedAt.toISOString(),
          responseDueAt: dateString(ticket.metadata.slaDueAt),
        },
        attachments,
        thread,
        generatedAt: input.asOf ?? new Date(),
      }),
    };
  } catch (error) {
    if (error instanceof SupportTicketTranscriptError) throw error;
    throw new SupportTicketTranscriptError("support_ticket_storage_unavailable", "문의 기록 저장소가 연결되지 않았습니다.", 503);
  }
}

export function supportTicketTranscriptDownloadResponse(transcript: SupportTicketTranscript): Response {
  return markdownDownloadResponse({
    markdown: transcript.markdown,
    filename: transcript.filename,
    fallbackFilename: transcript.fallbackFilename,
  });
}

export function renderSupportTicketTranscript(input: SupportTicketTranscriptRenderInput): string {
  const { ticket, attachments, thread, generatedAt } = input;
  const lines = [
    `# ${ticket.subject} 문의 기록`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트 고객지원에 접수된 공개 대화 기록입니다. 내부 운영 메모와 담당자 정보는 포함하지 않습니다.",
    "",
    "## 문의 요약",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["접수번호", ticket.id],
        ["유형", ticket.category],
        ["상태", statusLabel(ticket.status)],
        ["우선순위", priorityLabel(ticket.priority)],
        ["이메일", ticket.email],
        ["접수일", formatDateTime(new Date(ticket.createdAt))],
        ["최근 업데이트", formatDateTime(new Date(ticket.updatedAt))],
        ["예상 응답 기준", ticket.responseDueAt ?? "미설정"],
      ],
    ),
    "",
    "## 첨부 파일",
    "",
    renderAttachments(attachments),
    "",
    "## 공개 대화",
    "",
    thread.map(renderMessage).join("\n\n"),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderAttachments(attachments: TranscriptAttachment[]): string {
  if (attachments.length === 0) return "공개 첨부 파일이 없습니다.";
  return markdownTable(
    ["파일", "크기", "형식", "업로드", "URL"],
    attachments.map((attachment) => [
      attachment.filename,
      attachment.sizeLabel,
      attachment.contentType,
      formatDateTime(new Date(attachment.createdAt)),
      attachment.archiveUrl,
    ]),
  );
}

function renderMessage(message: SupportTicketTranscriptMessage): string {
  return [
    `### ${authorLabel(message.authorType)} · ${formatDateTime(new Date(message.createdAt))}`,
    "",
    message.body.trim(),
  ].join("\n");
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
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

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function priorityLabel(priority: string): string {
  if (priority === "low") return "낮음";
  if (priority === "normal") return "보통";
  if (priority === "high") return "높음";
  if (priority === "urgent") return "긴급";
  return priority;
}

function authorLabel(authorType: SupportTicketMessageAuthor): string {
  if (authorType === "admin") return "창업노트";
  if (authorType === "system") return "시스템";
  return "나";
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

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
