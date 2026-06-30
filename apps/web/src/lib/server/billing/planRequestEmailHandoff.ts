import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { loadWorkspaceOverview } from "@/lib/server/workspace/overview";
import {
  BillingPlanRequestHistoryError,
  loadBillingPlanRequestForCompany,
  type BillingPlanRequestDetail,
} from "./planRequestHistory";

export interface BillingPlanRequestEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export interface BillingPlanRequestEmailHandoffInput {
  request: BillingPlanRequestDetail;
  companyName: string;
  currentPlanName: string;
  seatUsageLabel: string;
  senderName: string;
  senderEmail: string;
  recipientEmail: string;
  generatedAt?: Date;
}

export async function buildBillingPlanRequestEmailHandoff(input: {
  access: CompanyAccess;
  session: WebSession | null;
  requestId: string;
  asOf?: Date;
}): Promise<BillingPlanRequestEmailHandoff> {
  const [request, overview] = await Promise.all([
    loadBillingPlanRequestForCompany({
      access: input.access,
      requestId: input.requestId,
    }),
    loadWorkspaceOverview({ access: input.access, session: input.session }),
  ]);
  if (!request) {
    throw new BillingPlanRequestHistoryError("billing_plan_request_not_found", "플랜 전환 요청을 찾지 못했습니다.", 404, "requestId");
  }

  return renderBillingPlanRequestEmailHandoff({
    request,
    companyName: overview.currentCompany.name,
    currentPlanName: overview.plan.planName,
    seatUsageLabel: `${overview.seatUsage.activeSeats.toLocaleString("ko-KR")}명 사용 / ${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명 한도`,
    senderName: input.session?.user.name?.trim() || request.name || "창업노트 사용자",
    senderEmail: input.session?.user.email?.trim() || request.email,
    recipientEmail: billingRecipientEmail(),
    generatedAt: input.asOf ?? new Date(),
  });
}

export function renderBillingPlanRequestEmailHandoff(
  input: BillingPlanRequestEmailHandoffInput,
): BillingPlanRequestEmailHandoff {
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(`${input.companyName}-${planLabel(input.request.desiredPlan)}-${input.request.id.slice(0, 8)}`, "플랜전환요청");
  const subject = `[플랜 전환 요청] ${input.companyName} ${planLabel(input.request.desiredPlan)} ${seatLabel(input.request.seatCount)}`;
  const body = [
    "창업노트 청구 담당자님, 안녕하세요.",
    "",
    `${input.companyName} 워크스페이스의 플랜 전환 상담 요청입니다.`,
    "",
    `요청 번호: ${input.request.id}`,
    `요청자: ${input.request.name || input.senderName}`,
    `회신 이메일: ${input.request.email}`,
    `현재 플랜: ${input.currentPlanName}`,
    `현재 좌석: ${input.seatUsageLabel}`,
    `희망 플랜: ${planLabel(input.request.desiredPlan)}`,
    `희망 좌석: ${seatLabel(input.request.seatCount)}`,
    `희망 청구 주기: ${cycleLabel(input.request.billingCycle)}`,
    `요청 상태: ${statusLabel(input.request.status)}`,
    `요청 생성일: ${formatDateTime(input.request.requestedAt)}`,
    `handoff 생성일: ${formatDateTime(generatedAt.toISOString())}`,
    "",
    "요청 내용:",
    input.request.message,
    "",
    "운영 확인 항목:",
    "- 적용할 플랜과 좌석 한도",
    "- 계약/결제 시작일",
    "- 세금계산서 발행 여부와 수신 이메일",
    "- 결제 provider 포털 또는 수동 결제 안내 방식",
    "",
    "서비스 내 확인 경로:",
    "- /billing",
    "",
    "이 메일은 창업노트 청구 화면에서 생성한 플랜 전환 요청 handoff 문서입니다.",
    "",
  ].join("\n");

  return {
    filename: `창업노트-${filenameBase}-전환요청메일.eml`,
    fallbackFilename: `cunote-billing-plan-request-${input.request.id.slice(0, 8)}.eml`,
    eml: renderEml({
      from: formatAddress(input.senderName, input.senderEmail),
      to: billingRecipientName(),
      toEmail: input.recipientEmail,
      replyTo: input.request.email,
      subject,
      date: generatedAt,
      body,
    }),
  };
}

export function billingPlanRequestEmailHandoffDownloadResponse(
  handoff: BillingPlanRequestEmailHandoff,
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
  toEmail: string;
  replyTo: string;
  subject: string;
  date: Date;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${formatAddress(input.to, input.toEmail)}`,
    `Reply-To: <${input.replyTo.trim()}>`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: billing-plan-request-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function formatAddress(name: string, email: string): string {
  return `${encodeMimeWord(name)} <${email.trim()}>`;
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function billingRecipientEmail(): string {
  return process.env.CUNOTE_BILLING_EMAIL?.trim()
    || process.env.CUNOTE_SUPPORT_EMAIL?.trim()
    || "support@changupnote.com";
}

function billingRecipientName(): string {
  return process.env.CUNOTE_BILLING_CONTACT_NAME?.trim() || "창업노트 청구";
}

function planLabel(value: string | null): string {
  if (value === "team") return "Team";
  if (value === "growth") return "Growth";
  if (value === "enterprise") return "Enterprise";
  return "플랜";
}

function cycleLabel(value: string | null): string {
  if (value === "monthly") return "월간";
  if (value === "annual") return "연간";
  if (value === "undecided") return "상담 후 결정";
  return "미정";
}

function seatLabel(value: number | null): string {
  return value ? `${value.toLocaleString("ko-KR")}석` : "좌석 미확인";
}

function statusLabel(status: string): string {
  if (status === "open") return "접수";
  if (status === "in_progress") return "처리중";
  if (status === "waiting") return "답변 완료";
  if (status === "resolved") return "해결";
  if (status === "closed") return "종료";
  return status;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}
