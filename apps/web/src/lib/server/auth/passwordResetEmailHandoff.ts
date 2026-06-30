import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";

export interface PasswordResetEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface PasswordResetEmailHandoffInput {
  email: string;
  resetUrl: string;
  expiresInMinutes: number;
  generatedAt?: Date;
}

export const PASSWORD_RESET_EMAIL_SUBJECT = "[창업노트] 비밀번호 재설정 안내";

export class PasswordResetEmailHandoffError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "PasswordResetEmailHandoffError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function buildPasswordResetEmailHandoff(input: {
  email: unknown;
  resetUrl: unknown;
  expiresInMinutes: unknown;
  origin: string;
  asOf?: Date;
}): PasswordResetEmailHandoff {
  const email = emailValue(input.email);
  const resetUrl = resetUrlValue(input.resetUrl, input.origin);
  const expiresInMinutes = expiresValue(input.expiresInMinutes);
  return renderPasswordResetEmailHandoff({
    email,
    resetUrl,
    expiresInMinutes,
    generatedAt: input.asOf ?? new Date(),
  });
}

export function renderPasswordResetEmailHandoff(input: PasswordResetEmailHandoffInput): PasswordResetEmailHandoff {
  const legal = getLegalConfig();
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(input.email, "password-reset");
  const body = renderPasswordResetEmailText({
    ...input,
    generatedAt,
    supportEmail: legal.supportEmail,
    handoffNotice: true,
  });

  return {
    filename: `창업노트-${filenameBase}-비밀번호재설정.eml`,
    fallbackFilename: `cunote-password-reset-${stableId(input.email)}.eml`,
    eml: renderEml({
      from: formatAddress("창업노트 계정", legal.supportEmail),
      to: `<${input.email}>`,
      subject: PASSWORD_RESET_EMAIL_SUBJECT,
      date: generatedAt,
      body,
    }),
  };
}

export function renderPasswordResetEmailText(input: PasswordResetEmailHandoffInput & {
  supportEmail?: string;
  handoffNotice?: boolean;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    "창업노트 비밀번호 재설정 안내입니다.",
    "",
    `요청 이메일: ${input.email}`,
    `링크 만료: ${input.expiresInMinutes.toLocaleString("ko-KR")}분`,
    `메일 생성 시각: ${formatDateTime(generatedAt)}`,
    "",
    "아래 링크에서 새 비밀번호를 설정하세요.",
    input.resetUrl,
    "",
    "보안 안내:",
    "- 본인이 요청하지 않았다면 이 메일을 무시해주세요.",
    "- 링크는 한 번 사용하거나 만료 시간이 지나면 사용할 수 없습니다.",
  ];
  if (input.handoffNotice) {
    lines.push("- 이 파일은 이메일 provider가 연결되기 전 검증/운영 handoff용으로 생성되었습니다.");
  }
  lines.push("", `문의: ${input.supportEmail ?? getLegalConfig().supportEmail}`, "");
  return lines.join("\n");
}

export function passwordResetEmailHandoffDownloadResponse(handoff: PasswordResetEmailHandoff): Response {
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
    `To: ${input.to}`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: password-reset-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function formatAddress(name: string, email: string): string {
  return `${encodeMimeWord(name)} <${email.trim()}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function emailValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new PasswordResetEmailHandoffError("invalid_email", "이메일을 확인해주세요.", 400, "email");
  }
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PasswordResetEmailHandoffError("invalid_email", "이메일을 확인해주세요.", 400, "email");
  }
  return email.slice(0, 160);
}

function resetUrlValue(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PasswordResetEmailHandoffError("invalid_reset_url", "재설정 링크를 확인해주세요.", 400, "resetUrl");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PasswordResetEmailHandoffError("invalid_reset_url", "재설정 링크를 확인해주세요.", 400, "resetUrl");
  }
  if (url.origin !== origin || url.pathname !== "/reset-password" || !url.searchParams.get("token")) {
    throw new PasswordResetEmailHandoffError("invalid_reset_url", "재설정 링크를 확인해주세요.", 400, "resetUrl");
  }
  return url.toString();
}

function expiresValue(value: unknown): number {
  const minutes = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    throw new PasswordResetEmailHandoffError("invalid_expiry", "재설정 링크 만료 시간을 확인해주세요.", 400, "expiresInMinutes");
  }
  return minutes;
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
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "password-reset";
}
