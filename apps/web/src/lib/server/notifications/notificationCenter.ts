import { buildNotificationFeed } from "@cunote/core";
import type { MatchCard, NotificationFeedResult, NotificationItem, NotificationSettingsDto } from "@cunote/contracts";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { loadServiceDashboard } from "@/lib/server/serviceData";
import { buildApplicationPipeline, type ApplicationPipelineItem } from "@/lib/server/applications/pipeline";
import type {
  NotificationCenterItem,
  NotificationCenterResult,
  NotificationReceiptAction,
  NotificationReceiptStatus,
} from "@/lib/notifications/types";

interface NotificationReceipt {
  notificationId: string;
  status: NotificationReceiptStatus;
  readAt: string | null;
  dismissedAt: string | null;
}

interface NotificationReceiptStore {
  list(input: {
    access: CompanyAccess;
    notificationIds: string[];
  }): Promise<Map<string, NotificationReceipt>>;
  update(input: {
    access: CompanyAccess;
    item: NotificationItem;
    action: NotificationReceiptAction;
  }): Promise<NotificationReceipt>;
}

const memoryReceipts = new Map<string, NotificationReceipt>();

export async function loadNotificationCenter(input: {
  access: CompanyAccess;
  limit?: number;
  matches?: MatchCard[];
}): Promise<NotificationCenterResult> {
  const limit = input.limit ?? 8;
  const [matches, settings] = await Promise.all([
    input.matches
      ? Promise.resolve(input.matches)
      : loadServiceDashboard({
          companyId: input.access.companyId,
          userId: input.access.userId,
          limit: Math.max(40, limit * 4),
          writeMatchStates: false,
        }).then((dashboard) => dashboard.matches),
    getAppPreferencesStore().getNotificationSettings(input.access.userId),
  ]);
  const rawFeed = buildNotificationFeed({
    matches,
    limit: Math.max(40, limit * 4),
  });
  const applicationReminders = await buildApplicationReminderNotifications({
    access: input.access,
    matches,
    asOf: new Date(rawFeed.generatedAt),
  });
  const supportSlaNotifications = await buildSupportSlaNotifications({
    access: input.access,
    asOf: new Date(rawFeed.generatedAt),
  });
  const supportReplyNotifications = await buildSupportReplyNotifications({
    access: input.access,
  });
  const rawNotifications = sortNotifications([
    ...rawFeed.notifications,
    ...applicationReminders,
    ...supportSlaNotifications,
    ...supportReplyNotifications,
  ]);
  const configuredNotifications = rawNotifications.filter((item) =>
    notificationAllowedBySettings(item, settings)
  );
  const receiptMap = await safeListReceipts({
    access: input.access,
    notificationIds: configuredNotifications.map((item) => item.id),
  });
  const allItems = configuredNotifications.map((item) => toCenterItem(item, receiptMap.get(item.id)));
  const visibleItems = allItems
    .filter((item) => item.status !== "dismissed")
    .slice(0, limit);

  return {
    generatedAt: rawFeed.generatedAt,
    notifications: visibleItems,
    unreadCount: visibleItems.filter((item) => item.status === "unread").length,
    dismissedCount: allItems.filter((item) => item.status === "dismissed").length,
    settings,
  };
}

export async function loadNotificationFeed(input: {
  access: CompanyAccess;
  limit?: number;
  matches?: MatchCard[];
}): Promise<NotificationFeedResult> {
  const center = await loadNotificationCenter(input);
  return {
    generatedAt: center.generatedAt,
    notifications: center.notifications.map(({ href: _href, status: _status, readAt: _readAt, dismissedAt: _dismissedAt, ...item }) => item),
  };
}

export async function updateNotificationReceipt(input: {
  access: CompanyAccess;
  notificationId: string;
  action: NotificationReceiptAction;
}): Promise<NotificationCenterItem> {
  const item = await findCurrentNotification(input);
  const receipt = await safeUpdateReceipt({
    access: input.access,
    item,
    action: input.action,
  });
  return toCenterItem(item, receipt);
}

function notificationAllowedBySettings(
  item: NotificationItem,
  settings: NotificationSettingsDto,
): boolean {
  if (item.kind === "deadline") return settings.deadlineReminder;
  if (item.kind === "new_match" || item.kind === "soon_eligible") return settings.newMatch;
  return true;
}

async function buildApplicationReminderNotifications(input: {
  access: CompanyAccess;
  matches: MatchCard[];
  asOf: Date;
}): Promise<NotificationItem[]> {
  try {
    const pipeline = await buildApplicationPipeline({
      access: input.access,
      matches: input.matches,
      now: input.asOf,
    });
    return pipeline.items.flatMap((item) => applicationReminderNotification(item, input.asOf));
  } catch {
    return [];
  }
}

function applicationReminderNotification(
  item: ApplicationPipelineItem,
  asOf: Date,
): NotificationItem[] {
  if (!item.reminderAt) return [];
  const dDay = daysUntil(item.reminderAt, asOf);
  if (dDay < -14 || dDay > 7) return [];
  const assignee = item.assigneeName ? `담당 ${item.assigneeName}. ` : "";
  const note = item.outcomeNote ? `메모: ${item.outcomeNote}` : "신청 보드에서 결과와 후속 조치를 확인하세요.";
  return [{
    id: `application_reminder:${item.grantId}:${item.reminderAt}`,
    kind: "deadline",
    title: applicationReminderTitle(item, dDay),
    body: `${assignee}${item.stageLabel} 단계의 내부 리마인더입니다. ${note}`,
    priority: dDay <= 0 ? "high" : dDay <= 3 ? "medium" : "low",
    target: "/applications",
    grantId: item.grantId,
    dDay,
    etaDate: item.reminderAt,
    rulesetVer: "application-pipeline-v1",
  }];
}

function applicationReminderTitle(item: ApplicationPipelineItem, dDay: number): string {
  if (dDay < 0) return `리마인더 지남: ${item.title}`;
  if (dDay === 0) return `오늘 리마인더: ${item.title}`;
  return `리마인더 D-${dDay}: ${item.title}`;
}

async function buildSupportSlaNotifications(input: {
  access: CompanyAccess;
  asOf: Date;
}): Promise<NotificationItem[]> {
  if (!hasDatabaseUrl()) return [];
  try {
    const rows = await getCunoteDb()
      .select({
        id: schema.supportTickets.id,
        subject: schema.supportTickets.subject,
        status: schema.supportTickets.status,
        priority: schema.supportTickets.priority,
        metadata: schema.supportTickets.metadata,
        updatedAt: schema.supportTickets.updatedAt,
      })
      .from(schema.supportTickets)
      .where(supportTicketAccessWhere(input.access))
      .orderBy(desc(schema.supportTickets.updatedAt))
      .limit(30);

    return rows.flatMap((row) => supportSlaNotification(row, input.asOf));
  } catch {
    return [];
  }
}

function supportSlaNotification(
  ticket: {
    id: string;
    subject: string;
    status: string;
    priority: string;
    metadata: Record<string, unknown>;
  },
  asOf: Date,
): NotificationItem[] {
  if (ticket.status === "resolved" || ticket.status === "closed" || ticket.status === "waiting") {
    return [];
  }
  const slaDueAt = dateString(ticket.metadata.slaDueAt);
  if (!slaDueAt) return [];
  const dDay = daysUntil(slaDueAt, asOf);
  if (dDay < -14 || dDay > 7) return [];
  return [{
    id: `support_sla:${ticket.id}:${slaDueAt}`,
    kind: "needs_input",
    title: supportSlaTitle(ticket.subject, dDay),
    body: `고객지원 문의가 ${ticketStatusLabel(ticket.status)} 상태입니다. ${ticketPriorityLabel(ticket.priority)} 우선순위로 운영팀 응답 기준일을 확인하세요.`,
    priority: dDay <= 0 ? "high" : dDay <= 2 ? "medium" : "low",
    target: "/settings?section=activity",
    dDay,
    etaDate: slaDueAt,
    rulesetVer: "support-sla-v1",
  }];
}

async function buildSupportReplyNotifications(input: {
  access: CompanyAccess;
}): Promise<NotificationItem[]> {
  if (!hasDatabaseUrl()) return [];
  try {
    const db = getCunoteDb();
    const tickets = await db
      .select({
        id: schema.supportTickets.id,
        subject: schema.supportTickets.subject,
        status: schema.supportTickets.status,
        priority: schema.supportTickets.priority,
        updatedAt: schema.supportTickets.updatedAt,
      })
      .from(schema.supportTickets)
      .where(supportTicketAccessWhere(input.access))
      .orderBy(desc(schema.supportTickets.updatedAt))
      .limit(30);

    const waitingTickets = tickets.filter((ticket) => ticket.status === "waiting");
    if (waitingTickets.length === 0) return [];

    const ticketById = new Map(waitingTickets.map((ticket) => [ticket.id, ticket]));
    const messages = await db
      .select({
        id: schema.supportTicketMessages.id,
        ticketId: schema.supportTicketMessages.ticketId,
        body: schema.supportTicketMessages.body,
        createdAt: schema.supportTicketMessages.createdAt,
      })
      .from(schema.supportTicketMessages)
      .where(and(
        inArray(schema.supportTicketMessages.ticketId, waitingTickets.map((ticket) => ticket.id)),
        eq(schema.supportTicketMessages.authorType, "admin"),
        eq(schema.supportTicketMessages.visibility, "public"),
      ))
      .orderBy(desc(schema.supportTicketMessages.createdAt))
      .limit(60);

    const latestByTicket = new Map<string, typeof messages[number]>();
    for (const message of messages) {
      if (!latestByTicket.has(message.ticketId)) latestByTicket.set(message.ticketId, message);
    }

    return [...latestByTicket.values()].flatMap((message) => {
      const ticket = ticketById.get(message.ticketId);
      return ticket ? supportReplyNotification(ticket, message) : [];
    });
  } catch {
    return [];
  }
}

function supportReplyNotification(
  ticket: {
    id: string;
    subject: string;
    priority: string;
  },
  message: {
    id: string;
    body: string;
    createdAt: Date;
  },
): NotificationItem[] {
  return [{
    id: `support_reply:${ticket.id}:${message.id}`,
    kind: "needs_input",
    title: `운영팀 답변 도착: ${ticket.subject}`,
    body: `고객지원 문의에 공개 답변이 도착했습니다. ${preview(message.body)}`,
    priority: ticket.priority === "urgent" || ticket.priority === "high" ? "high" : "medium",
    target: "/settings?section=activity",
    etaDate: message.createdAt.toISOString().slice(0, 10),
    rulesetVer: "support-reply-v1",
  }];
}

function supportTicketAccessWhere(access: CompanyAccess): SQL {
  const conditions: SQL[] = [
    eq(schema.supportTickets.companyId, access.companyId),
  ];
  const userId = uuidOrNull(access.userId);
  if (userId) conditions.push(eq(schema.supportTickets.userId, userId));
  return or(...conditions)!;
}

function supportSlaTitle(subject: string, dDay: number): string {
  if (dDay < 0) return `SLA 초과: ${subject}`;
  if (dDay === 0) return `오늘 응답 예정: ${subject}`;
  return `응답 예정 D-${dDay}: ${subject}`;
}

function ticketStatusLabel(status: string): string {
  if (status === "in_progress") return "처리 중";
  if (status === "open") return "접수됨";
  if (status === "waiting") return "사용자 답변 대기";
  if (status === "resolved") return "해결됨";
  if (status === "closed") return "종료됨";
  return status;
}

function ticketPriorityLabel(priority: string): string {
  if (priority === "urgent") return "긴급";
  if (priority === "high") return "높음";
  if (priority === "low") return "낮음";
  return "일반";
}

function daysUntil(dateValue: string, asOf: Date): number {
  const target = dateOnlyUtc(dateValue);
  const today = dateOnlyUtc(asOf.toISOString());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function dateOnlyUtc(value: string): Date {
  const [year = "1970", month = "1", day = "1"] = value.slice(0, 10).split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function preview(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function sortNotifications(notifications: NotificationItem[]): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const item of notifications) {
    const current = byId.get(item.id);
    if (!current || compareNotifications(item, current) < 0) byId.set(item.id, item);
  }
  return [...byId.values()].sort(compareNotifications);
}

function compareNotifications(left: NotificationItem, right: NotificationItem): number {
  const priorityDelta = priorityRank(right.priority) - priorityRank(left.priority);
  if (priorityDelta !== 0) return priorityDelta;

  const dDayDelta = dDayRank(left.dDay) - dDayRank(right.dDay);
  if (dDayDelta !== 0) return dDayDelta;

  return left.title.localeCompare(right.title, "ko");
}

function priorityRank(priority: NotificationItem["priority"]): number {
  return { low: 1, medium: 2, high: 3 }[priority];
}

function dDayRank(value: number | null | undefined): number {
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

async function findCurrentNotification(input: {
  access: CompanyAccess;
  notificationId: string;
  action: NotificationReceiptAction;
}): Promise<NotificationItem> {
  const center = await loadNotificationCenter({ access: input.access, limit: 40 });
  const item = center.notifications.find((notification) => notification.id === input.notificationId);
  if (!item) {
    throw new NotificationCenterError("notification_not_found", "현재 알림 피드에서 항목을 찾지 못했습니다.", 404);
  }
  return item;
}

function toCenterItem(
  item: NotificationItem,
  receipt: NotificationReceipt | undefined,
): NotificationCenterItem {
  return {
    ...item,
    href: notificationHref(item),
    status: receipt?.status ?? "unread",
    readAt: receipt?.readAt ?? null,
    dismissedAt: receipt?.dismissedAt ?? null,
  };
}

function notificationHref(item: NotificationItem): string {
  if (item.target.startsWith("grant:")) {
    return `/grants/${encodeURIComponent(item.target.slice("grant:".length))}`;
  }
  if (item.target.startsWith("profile:")) return "/settings#company-settings";
  if (item.target.startsWith("/")) return item.target;
  if (/^https?:\/\//.test(item.target)) return item.target;
  return "/dashboard";
}

async function safeListReceipts(input: {
  access: CompanyAccess;
  notificationIds: string[];
}): Promise<Map<string, NotificationReceipt>> {
  try {
    return await getNotificationReceiptStore().list(input);
  } catch {
    return getMemoryNotificationReceiptStore().list(input);
  }
}

async function safeUpdateReceipt(input: {
  access: CompanyAccess;
  item: NotificationItem;
  action: NotificationReceiptAction;
}): Promise<NotificationReceipt> {
  try {
    return await getNotificationReceiptStore().update(input);
  } catch {
    return getMemoryNotificationReceiptStore().update(input);
  }
}

function getNotificationReceiptStore(): NotificationReceiptStore {
  if (process.env.CUNOTE_REPOSITORY_ADAPTER === "drizzle") return new DrizzleNotificationReceiptStore();
  return getMemoryNotificationReceiptStore();
}

function getMemoryNotificationReceiptStore(): NotificationReceiptStore {
  return new MemoryNotificationReceiptStore();
}

class MemoryNotificationReceiptStore implements NotificationReceiptStore {
  async list(input: {
    access: CompanyAccess;
    notificationIds: string[];
  }): Promise<Map<string, NotificationReceipt>> {
    return new Map(input.notificationIds
      .map((notificationId) => memoryReceipts.get(receiptKey(input.access, notificationId)))
      .filter((receipt): receipt is NotificationReceipt => Boolean(receipt))
      .map((receipt) => [receipt.notificationId, receipt]));
  }

  async update(input: {
    access: CompanyAccess;
    item: NotificationItem;
    action: NotificationReceiptAction;
  }): Promise<NotificationReceipt> {
    const receipt = buildReceipt(input.item, input.action, new Date());
    memoryReceipts.set(receiptKey(input.access, input.item.id), receipt);
    return receipt;
  }
}

class DrizzleNotificationReceiptStore implements NotificationReceiptStore {
  async list(input: {
    access: CompanyAccess;
    notificationIds: string[];
  }): Promise<Map<string, NotificationReceipt>> {
    if (input.notificationIds.length === 0) return new Map();
    const rows = await withCunoteDbUser(getCunoteDb(), input.access.userId, async (db) => db
      .select({
        notificationId: schema.notificationReceipts.notificationId,
        status: schema.notificationReceipts.status,
        readAt: schema.notificationReceipts.readAt,
        dismissedAt: schema.notificationReceipts.dismissedAt,
      })
      .from(schema.notificationReceipts)
      .where(and(
        eq(schema.notificationReceipts.userId, input.access.userId),
        eq(schema.notificationReceipts.companyId, input.access.companyId),
        inArray(schema.notificationReceipts.notificationId, input.notificationIds),
      )));
    return new Map(rows.map((row) => [row.notificationId, toReceipt(row)]));
  }

  async update(input: {
    access: CompanyAccess;
    item: NotificationItem;
    action: NotificationReceiptAction;
  }): Promise<NotificationReceipt> {
    const now = new Date();
    const receipt = buildReceipt(input.item, input.action, now);
    const [row] = await withCunoteDbUser(getCunoteDb(), input.access.userId, async (db) => upsertReceipt(db, {
      ...input,
      receipt,
      now,
    }));
    if (!row) throw new Error("알림 상태 저장 결과가 없습니다.");
    return toReceipt(row);
  }
}

function upsertReceipt(
  db: CunoteDbSession,
  input: {
    access: CompanyAccess;
    item: NotificationItem;
    receipt: NotificationReceipt;
    now: Date;
  },
) {
  return db
    .insert(schema.notificationReceipts)
    .values({
      userId: input.access.userId,
      companyId: input.access.companyId,
      notificationId: input.item.id,
      kind: input.item.kind,
      target: input.item.target,
      status: input.receipt.status,
      readAt: input.receipt.readAt ? new Date(input.receipt.readAt) : null,
      dismissedAt: input.receipt.dismissedAt ? new Date(input.receipt.dismissedAt) : null,
      metadata: {
        grantId: input.item.grantId ?? null,
        rulesetVer: input.item.rulesetVer,
      },
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        schema.notificationReceipts.userId,
        schema.notificationReceipts.companyId,
        schema.notificationReceipts.notificationId,
      ],
      set: {
        kind: input.item.kind,
        target: input.item.target,
        status: input.receipt.status,
        readAt: input.receipt.readAt ? new Date(input.receipt.readAt) : null,
        dismissedAt: input.receipt.dismissedAt ? new Date(input.receipt.dismissedAt) : null,
        updatedAt: input.now,
      },
    })
    .returning({
      notificationId: schema.notificationReceipts.notificationId,
      status: schema.notificationReceipts.status,
      readAt: schema.notificationReceipts.readAt,
      dismissedAt: schema.notificationReceipts.dismissedAt,
    });
}

function buildReceipt(
  item: NotificationItem,
  action: NotificationReceiptAction,
  now: Date,
): NotificationReceipt {
  const timestamp = now.toISOString();
  return {
    notificationId: item.id,
    status: action === "dismiss" ? "dismissed" : "read",
    readAt: timestamp,
    dismissedAt: action === "dismiss" ? timestamp : null,
  };
}

function toReceipt(row: {
  notificationId: string;
  status: NotificationReceiptStatus;
  readAt: Date | null;
  dismissedAt: Date | null;
}): NotificationReceipt {
  return {
    notificationId: row.notificationId,
    status: row.status,
    readAt: row.readAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  };
}

function receiptKey(access: CompanyAccess, notificationId: string): string {
  return `${access.userId}:${access.companyId}:${notificationId}`;
}

export class NotificationCenterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "NotificationCenterError";
    this.code = code;
    this.status = status;
  }
}
