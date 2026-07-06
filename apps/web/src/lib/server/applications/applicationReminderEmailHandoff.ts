import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { sanitizeDownloadFilename, textDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { loadServiceDashboard } from "@/lib/server/serviceData";
import { buildApplicationPipeline, type ApplicationPipelineItem } from "./pipeline";

export interface ApplicationReminderEmailHandoff {
  filename: string;
  fallbackFilename: string;
  eml: string;
}

export class ApplicationReminderEmailHandoffError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApplicationReminderEmailHandoffError";
  }
}

export async function buildApplicationReminderEmailHandoff(input: {
  grantId: string;
  access: CompanyAccess;
  session: WebSession | null;
  origin: string;
  asOf?: Date;
}): Promise<ApplicationReminderEmailHandoff> {
  const dashboard = await loadServiceDashboard({
    companyId: input.access.companyId,
    userId: input.access.userId,
    limit: 80,
    writeMatchStates: false,
  });
  const pipeline = await buildApplicationPipeline({
    access: input.access,
    matches: dashboard.matches,
    now: input.asOf ?? new Date(),
  });
  const item = pipeline.items.find((candidate) => candidate.grantId === input.grantId);
  if (!item) {
    throw new ApplicationReminderEmailHandoffError(
      "application_reminder_email_not_found",
      "신청 파이프라인에서 공고를 찾지 못했습니다.",
      404,
      "grantId",
    );
  }
  const recipientEmail = resolveRecipientEmail(input.session);

  return renderApplicationReminderEmailHandoff({
    item,
    companyName: dashboard.company.name ?? "현재 회사",
    recipientEmail,
    generatedAt: input.asOf ?? new Date(),
    detailUrl: absoluteUrl(input.origin, item.detailHref),
  });
}

export function renderApplicationReminderEmailHandoff(input: {
  item: ApplicationPipelineItem;
  companyName: string;
  recipientEmail: string;
  detailUrl: string;
  generatedAt?: Date;
}): ApplicationReminderEmailHandoff {
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(input.item.title, "신청리마인더");
  const subject = `[창업노트] ${input.item.title} 신청 후속 확인`;
  const body = [
    "안녕하세요.",
    "",
    `${input.companyName}의 지원사업 신청 후속 확인 메일입니다.`,
    "",
    `공고: ${input.item.title}`,
    input.item.agency ? `운영기관: ${input.item.agency}` : null,
    `현재 단계: ${input.item.stageLabel}`,
    `다음 액션: ${input.item.nextAction}`,
    `지원금/혜택: ${input.item.supportLabel}`,
    input.item.fitScore !== null ? `적합도: ${input.item.fitScore}` : "적합도: 매칭 밖 · 직접 준비",
    input.item.applyEnd ? `신청 마감: ${formatDate(input.item.applyEnd)}` : "신청 마감: 일정 확인 필요",
    input.item.reminderAt ? `내부 리마인더: ${formatDate(input.item.reminderAt)}` : null,
    input.item.assigneeName ? `담당자: ${input.item.assigneeName}` : null,
    input.item.outcomeNote ? `후속 메모: ${input.item.outcomeNote}` : null,
    "",
    `창업노트 상세: ${input.detailUrl}`,
    "",
    "실제 제출 여부와 선정 결과는 각 지원사업 공식 포털과 담당 기관 공지를 기준으로 최종 확인해주세요.",
    "",
    "-- ",
    "창업노트 신청 관리",
    "",
  ].filter((line): line is string => line !== null).join("\n");

  return {
    filename: `창업노트-${filenameBase}-신청리마인더.eml`,
    fallbackFilename: `cunote-application-reminder-${stableId(input.item.grantId)}.eml`,
    eml: renderEml({
      from: applicationsFromAddress(),
      to: input.recipientEmail,
      subject,
      date: generatedAt,
      body,
    }),
  };
}

export function applicationReminderEmailHandoffDownloadResponse(
  handoff: ApplicationReminderEmailHandoff,
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
  subject: string;
  date: Date;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: <${input.to.trim()}>`,
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Cunote-Handoff: application-reminder-email",
  ];
  return `${[...headers, "", input.body.replace(/\r?\n/g, "\r\n")].join("\r\n")}\r\n`;
}

function applicationsFromAddress(): string {
  const email = process.env.CUNOTE_APPLICATIONS_EMAIL?.trim()
    || process.env.CUNOTE_SUPPORT_EMAIL?.trim()
    || "support@changupnote.com";
  return `=?UTF-8?B?${Buffer.from("창업노트 신청 관리", "utf8").toString("base64")}?= <${email}>`;
}

function resolveRecipientEmail(session: WebSession | null): string {
  return session?.user.email?.trim()
    || process.env.CUNOTE_APPLICATIONS_EMAIL?.trim()
    || process.env.CUNOTE_SUPPORT_EMAIL?.trim()
    || "support@changupnote.com";
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function absoluteUrl(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function stableId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "grant";
}
