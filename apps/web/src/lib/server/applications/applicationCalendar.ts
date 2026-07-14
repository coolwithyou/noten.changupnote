import { and, desc, eq } from "drizzle-orm";
import type { FeedbackKind, SupportAmount } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { loadServiceApplySheet, loadServiceDashboard } from "@/lib/server/serviceData";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import {
  applicationManagementFromPayload,
  listRuntimeApplicationManagementFeedback,
  type ApplicationManagement,
} from "./applicationManagementFeedback";
import { buildApplicationPipeline, type ApplicationPipelineItem } from "./pipeline";
import {
  IcsDateError,
  renderIcsCalendar,
  stableId,
  type CalendarIcsEvent,
} from "@/lib/server/calendar/ics";

export class ApplicationCalendarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApplicationCalendarError";
  }
}

export interface ApplicationCalendarDownload {
  filename: string;
  fallbackFilename: string;
  ics: string;
}

interface FeedbackCalendarSnapshot {
  kind: FeedbackKind | null;
  management: ApplicationManagement | null;
}

export async function buildApplicationCalendar(input: {
  grantId: string;
  access: CompanyAccess;
  asOf?: Date;
}): Promise<ApplicationCalendarDownload> {
  const generatedAt = input.asOf ?? new Date();
  const sheet = await loadServiceApplySheet(input.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
    asOf: generatedAt,
  });
  if (!sheet) {
    throw new ApplicationCalendarError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
  }

  const feedback = await loadFeedbackCalendarSnapshot({
    grantId: sheet.grant.id,
    access: input.access,
  });
  const events: CalendarIcsEvent[] = [];
  const description = buildDescription({
    title: sheet.grant.title,
    agency: sheet.grant.agency,
    applyMethod: sheet.applyMethod,
    supportLabel: formatSupportAmount(sheet.grant.supportAmount),
    deepLink: sheet.deepLink,
    management: feedback.management,
    kind: feedback.kind,
  });

  if (sheet.schedule.applyEnd) {
    events.push({
      uid: `deadline-${stableId(sheet.grant.id)}@cunote`,
      date: sheet.schedule.applyEnd,
      summary: `마감: ${sheet.grant.title}`,
      description,
      url: sheet.deepLink,
    });
  }

  if (feedback.management?.reminderAt) {
    events.push({
      uid: `reminder-${stableId(sheet.grant.id)}-${feedback.management.reminderAt}@cunote`,
      date: feedback.management.reminderAt,
      summary: `리마인더: ${sheet.grant.title}`,
      description,
      url: sheet.deepLink,
    });
  }

  if (events.length === 0) {
    throw new ApplicationCalendarError(
      "application_calendar_unavailable",
      "캘린더에 넣을 마감일이나 리마인더가 없습니다.",
      409,
      "grantId",
    );
  }

  return {
    filename: `창업노트-${sanitizeDownloadFilename(sheet.grant.title, "지원사업")}-일정.ics`,
    fallbackFilename: `cunote-application-calendar-${stableId(sheet.grant.id)}.ics`,
    ics: renderCalendarIcs({
      productId: "-//Cunote//Application Calendar//KO",
      generatedAt,
      events,
    }),
  };
}

export async function buildApplicationBoardCalendar(input: {
  access: CompanyAccess;
  asOf?: Date;
}): Promise<ApplicationCalendarDownload> {
  const generatedAt = input.asOf ?? new Date();
  const dashboard = await loadServiceDashboard({
    companyId: input.access.companyId,
    userId: input.access.userId,
    limit: 80,
    writeMatchStates: false,
  });
  const pipeline = await buildApplicationPipeline({
    access: input.access,
    matches: dashboard.matches,
    now: generatedAt,
  });
  const events = pipeline.items
    .filter((item) => item.stage !== "dismissed")
    .flatMap((item) => pipelineCalendarEvents(item));

  if (events.length === 0) {
    throw new ApplicationCalendarError(
      "application_board_calendar_unavailable",
      "캘린더에 넣을 마감일이나 리마인더가 없습니다.",
      409,
    );
  }

  const companyName = dashboard.company.name ?? "현재 회사";
  const filenameBase = sanitizeDownloadFilename(companyName, "워크스페이스");
  return {
    filename: `창업노트-${filenameBase}-신청일정-${dateStamp(generatedAt)}.ics`,
    fallbackFilename: `cunote-application-board-calendar-${dateStamp(generatedAt)}.ics`,
    ics: renderCalendarIcs({
      productId: "-//Cunote//Application Board Calendar//KO",
      generatedAt,
      events,
    }),
  };
}

function pipelineCalendarEvents(item: ApplicationPipelineItem): CalendarIcsEvent[] {
  const description = buildPipelineDescription(item);
  const events: CalendarIcsEvent[] = [];
  if (item.applyEnd) {
    events.push({
      uid: `board-deadline-${stableId(item.grantId)}@cunote`,
      date: item.applyEnd,
      summary: `마감: ${item.title}`,
      description,
      url: item.detailHref,
    });
  }
  if (item.reminderAt) {
    events.push({
      uid: `board-reminder-${stableId(item.grantId)}-${item.reminderAt}@cunote`,
      date: item.reminderAt,
      summary: `리마인더: ${item.title}`,
      description,
      url: item.detailHref,
    });
  }
  return events;
}

async function loadFeedbackCalendarSnapshot(input: {
  grantId: string;
  access: CompanyAccess;
}): Promise<FeedbackCalendarSnapshot> {
  const runtimeSnapshot = listRuntimeApplicationManagementFeedback({
    companyId: input.access.companyId,
    userId: input.access.userId,
    grantIds: [input.grantId],
  }).get(input.grantId);
  const initialSnapshot: FeedbackCalendarSnapshot = {
    kind: runtimeSnapshot?.kind ?? null,
    management: runtimeSnapshot?.management ?? null,
  };
  if (!hasDatabaseUrl()) return initialSnapshot;
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select({
        value: schema.feedback.value,
      })
      .from(schema.feedback)
      .where(and(
        eq(schema.feedback.targetType, "match"),
        eq(schema.feedback.targetId, `${input.access.companyId}:${input.grantId}`),
      ))
      .orderBy(desc(schema.feedback.ts))
      .limit(20));

    let kind: FeedbackKind | null = initialSnapshot.kind;
    let management: ApplicationManagement | null = initialSnapshot.management;
    for (const row of rows) {
      if (!kind) kind = feedbackKind(row.value?.kind);
      if (!management) management = applicationManagementFromPayload(row.value?.payload);
      if (kind && management) break;
    }
    return { kind, management };
  } catch (error) {
    console.warn(`Application calendar feedback lookup failed: ${errorMessage(error)}`);
    return initialSnapshot;
  }
}

// ics 렌더러는 @/lib/server/calendar/ics로 이전했다. 렌더링 중 날짜 오류로
// IcsDateError가 발생하면 기존과 동일한 ApplicationCalendarError 계약으로 재래핑한다.
function renderCalendarIcs(input: {
  productId: string;
  generatedAt: Date;
  events: CalendarIcsEvent[];
}): string {
  try {
    return renderIcsCalendar(input);
  } catch (error) {
    if (error instanceof IcsDateError) {
      throw new ApplicationCalendarError("invalid_calendar_date", error.message, 500);
    }
    throw error;
  }
}

function buildDescription(input: {
  title: string;
  agency: string | null;
  applyMethod: string | null;
  supportLabel: string;
  deepLink: string | null;
  management: ApplicationManagement | null;
  kind: FeedbackKind | null;
}): string {
  return [
    input.title,
    input.agency ? `운영기관: ${input.agency}` : null,
    `지원금: ${input.supportLabel}`,
    input.applyMethod ? `접수 방법: ${input.applyMethod}` : null,
    input.kind ? `신청 상태: ${feedbackKindLabel(input.kind)}` : null,
    input.management?.assigneeName ? `담당자: ${input.management.assigneeName}` : null,
    input.management?.outcomeNote ? `메모: ${input.management.outcomeNote}` : null,
    input.deepLink ? `공식 링크: ${input.deepLink}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function buildPipelineDescription(item: ApplicationPipelineItem): string {
  return [
    item.title,
    item.agency ? `운영기관: ${item.agency}` : null,
    `지원금: ${item.supportLabel}`,
    `신청 단계: ${item.stageLabel}`,
    item.fitScore !== null ? `조건 확인도: ${item.fitScore}` : "조건 확인도: 매칭 밖 · 직접 준비",
    item.assigneeName ? `담당자: ${item.assigneeName}` : null,
    item.outcomeNote ? `메모: ${item.outcomeNote}` : null,
    `창업노트 상세: ${item.detailHref}`,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function feedbackKind(value: unknown): FeedbackKind | null {
  if (
    value === "saved" ||
    value === "dismissed" ||
    value === "wrong" ||
    value === "applied" ||
    value === "selected" ||
    value === "rejected" ||
    value === "blocked" ||
    value === "note"
  ) {
    return value;
  }
  return null;
}

function feedbackKindLabel(kind: FeedbackKind): string {
  if (kind === "saved") return "저장";
  if (kind === "applied") return "제출";
  if (kind === "selected") return "선정";
  if (kind === "rejected") return "탈락";
  if (kind === "blocked") return "막힘";
  if (kind === "dismissed") return "보류";
  if (kind === "wrong") return "오류 신고";
  return "메모";
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (amount.max) return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
  return "금액 미확인";
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
