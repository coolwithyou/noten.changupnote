import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";

export interface AccountDeletionEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export function buildAccountDeletionEmailHandoff(input: {
  access: CompanyAccess;
  session: WebSession | null;
  asOf?: Date;
}): AccountDeletionEmailHandoff {
  const legal = getLegalConfig();
  const generatedAt = input.asOf ?? new Date();
  const senderEmail = input.session?.user.email?.trim()
    || legal.supportEmail
    || "support@changupnote.com";
  const senderName = input.session?.user.name?.trim() || "창업노트 사용자";
  const filenameBase = sanitizeDownloadFilename(senderEmail, "privacy-request");
  const subject = `[개인정보 권리 행사] 계정 데이터 삭제 요청`;
  const body = [
    `${legal.operatorName} 개인정보 담당자님, 안녕하세요.`,
    "",
    "창업노트 계정 데이터 삭제 또는 처리 정지를 요청합니다.",
    "",
    `요청자: ${senderName}`,
    `회신 이메일: ${senderEmail}`,
    `회사 ID: ${input.access.companyId}`,
    `사용자 ID: ${input.session?.user.id ?? input.access.userId}`,
    `현재 권한: ${input.access.role}`,
    `요청 생성 시각: ${formatDateTime(generatedAt)}`,
    "",
    "요청 범위:",
    "- 창업노트 계정 식별 정보",
    "- 현재 회사 워크스페이스 접근권한",
    "- 서비스 이용 중 저장된 알림, 신청 준비, 고객지원 공개 기록 중 삭제 또는 처리 정지가 가능한 항목",
    "",
    "확인 요청:",
    "- 법적 보존 의무가 있는 항목과 보존 기간",
    "- 삭제 또는 처리 정지 가능한 항목",
    "- 처리 예정일과 완료 회신 방법",
    "",
    "서비스 내 접수 경로:",
    "- /account#account-deletion-request",
    "",
    "이 메일은 창업노트 계정 화면에서 생성한 개인정보 권리 행사 handoff 문서입니다.",
    "",
  ].join("\n");

  return {
    filename: `창업노트-${filenameBase}-삭제요청.eml`,
    fallbackFilename: `cunote-account-deletion-request-${stableId(input.access.companyId)}.eml`,
    eml: renderEml({
      from: formatAddress(senderName, senderEmail),
      to: legal.privacyEmail,
      replyTo: senderEmail,
      subject,
      date: generatedAt,
      body,
    }),
  };
}

export function accountDeletionEmailHandoffDownloadResponse(
  handoff: AccountDeletionEmailHandoff,
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
    `To: ${formatAddress("창업노트 개인정보 담당", input.to)}`,
    `Reply-To: <${input.replyTo.trim()}>`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: account-deletion-request-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function formatAddress(name: string, email: string): string {
  return `${encodeMimeWord(name)} <${email.trim()}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
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
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "account";
}
