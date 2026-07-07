import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import type { SupportTicketCategory } from "./supportTickets";

export const SUPPORT_TICKET_INTAKE_EMAIL_TAG = "support_ticket_intake";

export interface SupportTicketIntakeEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface SupportTicketIntakeEmailHandoffInput {
  category: SupportTicketCategory;
  email: string;
  name: string | null;
  subject: string;
  message: string;
  ticketId?: string | null;
  hasAttachment?: boolean;
  attachmentFilename?: string | null;
  generatedAt?: Date;
}

export class SupportTicketIntakeEmailHandoffError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "SupportTicketIntakeEmailHandoffError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function buildSupportTicketIntakeEmailHandoff(input: Record<string, unknown>): SupportTicketIntakeEmailHandoff {
  return renderSupportTicketIntakeEmailHandoff({
    category: categoryValue(input.category),
    email: emailValue(input.email),
    name: optionalString(input.name, 80),
    subject: requiredString(input.subject, "subject", 120),
    message: messageValue(input.message),
    ticketId: optionalString(input.ticketId, 120),
    hasAttachment: input.hasAttachment === true,
    attachmentFilename: optionalString(input.attachmentFilename, 180),
  });
}

export function renderSupportTicketIntakeEmailHandoff(
  input: SupportTicketIntakeEmailHandoffInput,
): SupportTicketIntakeEmailHandoff {
  const legal = getLegalConfig();
  const generatedAt = input.generatedAt ?? new Date();
  const ticketLabel = input.ticketId?.trim() || "providerless";
  const filenameBase = sanitizeDownloadFilename(`${categoryLabel(input.category)}-${input.subject}`, "support-ticket");

  return {
    filename: `창업노트-${filenameBase}-문의메일.eml`,
    fallbackFilename: `cunote-support-ticket-${stableId(ticketLabel)}.eml`,
    eml: renderEml({
      from: formatAddress(input.name || "창업노트 문의자", input.email),
      to: formatAddress("창업노트 고객지원", legal.supportEmail),
      replyTo: input.email,
      subject: supportTicketIntakeEmailSubject(input),
      date: generatedAt,
      body: renderSupportTicketIntakeEmailText({ ...input, generatedAt }),
    }),
  };
}

export function supportTicketIntakeEmailSubject(input: Pick<SupportTicketIntakeEmailHandoffInput, "category" | "subject">): string {
  return `[고객지원] ${categoryLabel(input.category)} · ${input.subject}`;
}

export function renderSupportTicketIntakeEmailText(input: SupportTicketIntakeEmailHandoffInput): string {
  const legal = getLegalConfig();
  const generatedAt = input.generatedAt ?? new Date();
  const ticketLabel = input.ticketId?.trim() || "providerless";
  return [
    `${legal.operatorName} 운영팀에 전달할 고객지원 문의입니다.`,
    "",
    `접수번호: ${ticketLabel}`,
    `문의 유형: ${categoryLabel(input.category)}`,
    `요청자: ${input.name || "이름 미입력"}`,
    `회신 이메일: ${input.email}`,
    `생성 시각: ${formatDateTime(generatedAt)}`,
    input.hasAttachment
      ? `첨부 파일: ${input.attachmentFilename ?? "별도 첨부 필요"}`
      : "첨부 파일: 없음",
    "",
    "제목:",
    input.subject,
    "",
    "문의 내용:",
    input.message,
    "",
    "운영 확인 항목:",
    "- 서비스 내 티켓 저장 여부",
    "- 회신이 필요한 이메일",
    "- 권한/개인정보/결제/공고 마감 등 우선 처리 사유",
    "",
    "서비스 내 접수 경로:",
    "- /support#support-ticket-form",
    "",
    "이 메일은 창업노트 고객지원 화면에서 생성한 문의 접수 handoff 문서입니다.",
    input.hasAttachment ? "첨부 원본은 이 .eml 파일에 포함되지 않으므로 메일 발송 시 별도로 첨부해주세요." : "",
    "",
  ].filter(Boolean).join("\n");
}

export function supportTicketIntakeEmailHandoffDownloadResponse(
  handoff: SupportTicketIntakeEmailHandoff,
): Response {
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
  replyTo: string;
  subject: string;
  date: Date;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Reply-To: <${input.replyTo.trim()}>`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: support-ticket-intake-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function formatAddress(name: string, email: string): string {
  return `${encodeMimeWord(name)} <${email.trim()}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function categoryValue(value: unknown): SupportTicketCategory {
  if (value === "product" || value === "account" || value === "privacy" || value === "billing" || value === "bug") {
    return value;
  }
  throw new SupportTicketIntakeEmailHandoffError("invalid_category", "문의 유형을 선택해주세요.", 400, "category");
}

function emailValue(value: unknown): string {
  const email = requiredString(value, "email", 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SupportTicketIntakeEmailHandoffError("invalid_email", "답변을 받을 이메일을 확인해주세요.", 400, "email");
  }
  return email;
}

function messageValue(value: unknown): string {
  const message = requiredString(value, "message", 4000);
  if (message.length < 10) {
    throw new SupportTicketIntakeEmailHandoffError("message_too_short", "문의 내용을 10자 이상 입력해주세요.", 400, "message");
  }
  return message;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const result = optionalString(value, maxLength);
  if (!result) throw new SupportTicketIntakeEmailHandoffError("required_field", "필수 입력값을 확인해주세요.", 400, field);
  return result;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function categoryLabel(value: SupportTicketCategory): string {
  if (value === "product") return "제품 문의";
  if (value === "account") return "계정/회사 권한";
  if (value === "privacy") return "개인정보/삭제 요청";
  if (value === "billing") return "플랜/청구";
  if (value === "coaching") return "작성 코칭 신청";
  return "오류 신고";
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

function stableId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "support-ticket";
}
