import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  buildAdminReviewQueueItems,
  type AdminReviewQueueItem,
} from "./reviewQueue";
import {
  countAdminBillingSubscriptions,
  listAdminBillingSubscriptions,
  type AdminBillingSubscriptionItem,
} from "@/lib/server/billing/subscription";
import {
  countAdminBillingInvoices,
  listAdminBillingInvoices,
  type AdminBillingInvoiceItem,
} from "@/lib/server/billing/invoices";
import {
  countAdminBillingPaymentMethods,
  listAdminBillingPaymentMethods,
  type AdminBillingPaymentMethodItem,
} from "@/lib/server/billing/paymentMethods";
import {
  countAdminBillingTaxProfiles,
  listAdminBillingTaxProfiles,
  type AdminBillingTaxProfileItem,
} from "@/lib/server/billing/taxProfile";
import {
  countAdminBillingTaxDocuments,
  listAdminBillingTaxDocuments,
  type AdminBillingTaxDocumentItem,
} from "@/lib/server/billing/taxDocuments";
import {
  countAdminBillingWebhookEvents,
  listAdminBillingWebhookEvents,
  type AdminBillingWebhookEventItem,
} from "@/lib/server/billing/webhooks";
import {
  countAdminGrantDocumentDraftQualityEvents,
  countAdminGrantDocumentDrafts,
  listAdminGrantDocumentDraftMetrics,
  listAdminGrantDocumentDraftQualityEvents,
  type AdminGrantDocumentDraftMetricItem,
  type AdminGrantDocumentDraftQualityEventItem,
} from "@/lib/server/documents/grantDocumentDraftMetrics";

export interface AdminFlywheelSnapshot {
  generatedAt: string;
  counts: {
    extractionLog: number;
    feedback: number;
    matchEvents: number;
    goldenSet: number;
    evalRuns: number;
    grantInsightSnapshots: number;
    grantAttachmentArchives: number;
    grantDocumentDrafts: number;
    grantDocumentDraftQualityEvents: number;
    supportTickets: number;
    billingSubscriptions: number;
    billingTaxProfiles: number;
    billingTaxDocuments: number;
    billingInvoices: number;
    billingPaymentMethods: number;
    billingWebhookEvents: number;
    reviewQueue: number;
  };
  recent: {
    extractionLog: AdminExtractionLogItem[];
    feedback: AdminFeedbackItem[];
    matchEvents: AdminMatchEventItem[];
    goldenSet: AdminGoldenSetItem[];
    evalRuns: AdminEvalRunItem[];
    grantInsightSnapshots: AdminGrantInsightSnapshotItem[];
    grantAttachmentArchives: AdminGrantAttachmentArchiveItem[];
    grantDocumentDrafts: AdminGrantDocumentDraftMetricItem[];
    grantDocumentDraftQualityEvents: AdminGrantDocumentDraftQualityEventItem[];
    supportTickets: AdminSupportTicketItem[];
    billingSubscriptions: AdminBillingSubscriptionItem[];
    billingTaxProfiles: AdminBillingTaxProfileItem[];
    billingTaxDocuments: AdminBillingTaxDocumentItem[];
    billingInvoices: AdminBillingInvoiceItem[];
    billingPaymentMethods: AdminBillingPaymentMethodItem[];
    billingWebhookEvents: AdminBillingWebhookEventItem[];
    reviewQueue: AdminReviewQueueItem[];
  };
}

export interface AdminExtractionLogItem {
  id: string;
  grantId: string | null;
  inputRef: string;
  status: string;
  confidence: number;
  modelVer: string;
  promptVer: string;
  ts: string;
}

export interface AdminFeedbackItem {
  id: string;
  targetType: string;
  targetId: string;
  type: string;
  actor: string;
  kind: string | null;
  outcome: string | null;
  reasonCode: string | null;
  hasCorrection: boolean;
  valueKeys: string[];
  ts: string;
}

export interface AdminMatchEventItem {
  id: string;
  companyId: string;
  grantId: string;
  event: string;
  rulesetVer: string;
  ts: string;
}

export interface AdminGoldenSetItem {
  id: string;
  kind: string;
  ref: string;
  goldenVer: string;
}

export interface AdminEvalRunItem {
  id: string;
  target: string;
  goldenVer: string;
  metricKeys: string[];
  accuracy: number | null;
  coverage: number | null;
  evaluable: number | null;
  ts: string;
}

export interface AdminGrantInsightSnapshotItem {
  id: string;
  kind: string;
  generatedAt: string;
  metricKeys: string[];
  insightCount: number;
}

export interface AdminGrantAttachmentArchiveItem {
  id: string;
  source: string;
  sourceId: string;
  filename: string;
  conversionStatus: string | null;
  archiveUrl: string | null;
  markdownUrl: string | null;
  updatedAt: string;
}

export interface AdminSupportTicketItem {
  id: string;
  category: string;
  subject: string;
  messagePreview: string;
  status: string;
  priority: string;
  email: string;
  createdAt: string;
  assignedTo: string | null;
  slaDueAt: string | null;
  slaStatus: "none" | "due_soon" | "overdue" | "ok";
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageVisibility: "public" | "internal" | null;
  attachmentCount: number;
  lastAttachmentFilename: string | null;
  lastAttachmentUrl: string | null;
}

export async function getAdminFlywheelSnapshot(limit = 8): Promise<AdminFlywheelSnapshot> {
  const db = getCunoteDb();
  const safeLimit = Math.max(1, Math.min(20, limit));

  const [
    extractionCount,
    feedbackCount,
    matchEventCount,
    goldenCount,
    evalCount,
    grantInsightSnapshotCount,
    grantAttachmentArchiveCount,
    grantDocumentDraftCount,
    grantDocumentDraftQualityEventCount,
    supportTicketCount,
    billingSubscriptionCount,
    billingTaxProfileCount,
    billingTaxDocumentCount,
    billingInvoiceCount,
    billingPaymentMethodCount,
    billingWebhookEventCount,
    extractionRows,
    feedbackRows,
    matchEventRows,
    goldenRows,
    evalRows,
    grantInsightSnapshotRows,
    grantAttachmentArchiveRows,
    grantDocumentDraftRows,
    grantDocumentDraftQualityEventRows,
    supportTicketRows,
    billingSubscriptionRows,
    billingTaxProfileRows,
    billingTaxDocumentRows,
    billingInvoiceRows,
    billingPaymentMethodRows,
    billingWebhookEventRows,
    reviewFeedbackRows,
  ] = await Promise.all([
    rowCount(db.select({ value: count() }).from(schema.extractionLog)),
    rowCount(db.select({ value: count() }).from(schema.feedback)),
    rowCount(db.select({ value: count() }).from(schema.matchEvents)),
    rowCount(db.select({ value: count() }).from(schema.goldenSet)),
    rowCount(db.select({ value: count() }).from(schema.evalRuns)),
    rowCount(db.select({ value: count() }).from(schema.grantInsightSnapshots)),
    rowCount(db.select({ value: count() }).from(schema.grantAttachmentArchives)),
    countAdminGrantDocumentDrafts(),
    countAdminGrantDocumentDraftQualityEvents(),
    rowCount(db.select({ value: count() }).from(schema.supportTickets)),
    countAdminBillingSubscriptions(),
    countAdminBillingTaxProfiles(),
    countAdminBillingTaxDocuments(),
    countAdminBillingInvoices(),
    countAdminBillingPaymentMethods(),
    countAdminBillingWebhookEvents(),
    db
      .select()
      .from(schema.extractionLog)
      .orderBy(desc(schema.extractionLog.ts))
      .limit(safeLimit),
    db
      .select()
      .from(schema.feedback)
      .orderBy(desc(schema.feedback.ts))
      .limit(safeLimit),
    db
      .select()
      .from(schema.matchEvents)
      .orderBy(desc(schema.matchEvents.ts))
      .limit(safeLimit),
    db
      .select()
      .from(schema.goldenSet)
      .orderBy(desc(schema.goldenSet.id))
      .limit(safeLimit),
    db
      .select()
      .from(schema.evalRuns)
      .orderBy(desc(schema.evalRuns.ts))
      .limit(safeLimit),
    db
      .select()
      .from(schema.grantInsightSnapshots)
      .orderBy(desc(schema.grantInsightSnapshots.generatedAt))
      .limit(safeLimit),
    db
      .select()
      .from(schema.grantAttachmentArchives)
      .orderBy(desc(schema.grantAttachmentArchives.updatedAt))
      .limit(safeLimit),
    listAdminGrantDocumentDraftMetrics(safeLimit),
    listAdminGrantDocumentDraftQualityEvents(safeLimit),
    db
      .select()
      .from(schema.supportTickets)
      .orderBy(desc(schema.supportTickets.createdAt))
      .limit(safeLimit),
    listAdminBillingSubscriptions(safeLimit),
    listAdminBillingTaxProfiles(safeLimit),
    listAdminBillingTaxDocuments(safeLimit),
    listAdminBillingInvoices(safeLimit),
    listAdminBillingPaymentMethods(safeLimit),
    listAdminBillingWebhookEvents(safeLimit),
    db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.targetType, "match"))
      .orderBy(desc(schema.feedback.ts))
      .limit(Math.max(50, safeLimit * 10)),
  ]);
  const reviewQueue = buildAdminReviewQueueItems(reviewFeedbackRows, safeLimit);
  const supportTicketMessageRows = supportTicketRows.length > 0
    ? await db
      .select({
        ticketId: schema.supportTicketMessages.ticketId,
        body: schema.supportTicketMessages.body,
        visibility: schema.supportTicketMessages.visibility,
        createdAt: schema.supportTicketMessages.createdAt,
      })
      .from(schema.supportTicketMessages)
      .where(inArray(schema.supportTicketMessages.ticketId, supportTicketRows.map((row) => row.id)))
      .orderBy(desc(schema.supportTicketMessages.createdAt))
    : [];
  const supportTicketMessages = summarizeSupportTicketMessages(supportTicketMessageRows);
  const supportTicketAttachmentRows = supportTicketRows.length > 0
    ? await db
      .select({
        ticketId: schema.supportTicketAttachments.ticketId,
        filename: schema.supportTicketAttachments.filename,
        archiveUrl: schema.supportTicketAttachments.archiveUrl,
        createdAt: schema.supportTicketAttachments.createdAt,
      })
      .from(schema.supportTicketAttachments)
      .where(and(
        inArray(schema.supportTicketAttachments.ticketId, supportTicketRows.map((row) => row.id)),
        eq(schema.supportTicketAttachments.status, "active"),
      ))
      .orderBy(desc(schema.supportTicketAttachments.createdAt))
    : [];
  const supportTicketAttachments = summarizeSupportTicketAttachments(supportTicketAttachmentRows);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      extractionLog: extractionCount,
      feedback: feedbackCount,
      matchEvents: matchEventCount,
      goldenSet: goldenCount,
      evalRuns: evalCount,
      grantInsightSnapshots: grantInsightSnapshotCount,
      grantAttachmentArchives: grantAttachmentArchiveCount,
      grantDocumentDrafts: grantDocumentDraftCount,
      grantDocumentDraftQualityEvents: grantDocumentDraftQualityEventCount,
      supportTickets: supportTicketCount,
      billingSubscriptions: billingSubscriptionCount,
      billingTaxProfiles: billingTaxProfileCount,
      billingTaxDocuments: billingTaxDocumentCount,
      billingInvoices: billingInvoiceCount,
      billingPaymentMethods: billingPaymentMethodCount,
      billingWebhookEvents: billingWebhookEventCount,
      reviewQueue: reviewQueue.length,
    },
    recent: {
      extractionLog: extractionRows.map((row) => ({
        id: row.id,
        grantId: row.grantId,
        inputRef: row.inputRef,
        status: row.status,
        confidence: row.confidence,
        modelVer: row.modelVer,
        promptVer: row.promptVer,
        ts: row.ts.toISOString(),
      })),
      feedback: feedbackRows.map((row) => ({
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        type: row.type,
        actor: row.actor,
        kind: stringValue(row.value.kind),
        outcome: stringValue(row.value.outcome),
        reasonCode: stringValue(row.value.reasonCode),
        hasCorrection: Boolean(row.value.correction),
        valueKeys: Object.keys(row.value).sort(),
        ts: row.ts.toISOString(),
      })),
      matchEvents: matchEventRows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        grantId: row.grantId,
        event: row.event,
        rulesetVer: row.rulesetVer,
        ts: row.ts.toISOString(),
      })),
      goldenSet: goldenRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        ref: row.ref,
        goldenVer: row.goldenVer,
      })),
      evalRuns: evalRows.map((row) => ({
        id: row.id,
        target: row.target,
        goldenVer: row.goldenVer,
        metricKeys: Object.keys(row.metrics).sort(),
        accuracy: numberValue(row.metrics.accuracy),
        coverage: numberValue(row.metrics.coverage),
        evaluable: numberValue(row.metrics.evaluable),
        ts: row.ts.toISOString(),
      })),
      grantInsightSnapshots: grantInsightSnapshotRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        generatedAt: row.generatedAt.toISOString(),
        metricKeys: Object.keys(row.metrics).sort(),
        insightCount: row.insights.length,
      })),
      grantAttachmentArchives: grantAttachmentArchiveRows.map((row) => ({
        id: row.id,
        source: row.source,
        sourceId: row.sourceId,
        filename: row.filename,
        conversionStatus: row.conversionStatus,
        archiveUrl: row.archiveUrl,
        markdownUrl: row.markdownUrl,
        updatedAt: row.updatedAt.toISOString(),
      })),
      grantDocumentDrafts: grantDocumentDraftRows,
      grantDocumentDraftQualityEvents: grantDocumentDraftQualityEventRows,
      supportTickets: supportTicketRows.map((row) => ({
        id: row.id,
        category: row.category,
        subject: row.subject,
        messagePreview: preview(row.message),
        status: row.status,
        priority: row.priority,
        email: row.email,
        createdAt: row.createdAt.toISOString(),
        assignedTo: stringValue(row.metadata.assignedTo),
        slaDueAt: dateString(row.metadata.slaDueAt),
        slaStatus: slaStatus(dateString(row.metadata.slaDueAt)),
        messageCount: supportTicketMessages.get(row.id)?.count ?? 0,
        lastMessageAt: supportTicketMessages.get(row.id)?.lastMessageAt ?? null,
        lastMessagePreview: supportTicketMessages.get(row.id)?.lastMessagePreview ?? null,
        lastMessageVisibility: supportTicketMessages.get(row.id)?.lastMessageVisibility ?? null,
        attachmentCount: supportTicketAttachments.get(row.id)?.count ?? 0,
        lastAttachmentFilename: supportTicketAttachments.get(row.id)?.lastAttachmentFilename ?? null,
        lastAttachmentUrl: supportTicketAttachments.get(row.id)?.lastAttachmentUrl ?? null,
      })),
      billingSubscriptions: billingSubscriptionRows,
      billingTaxProfiles: billingTaxProfileRows,
      billingTaxDocuments: billingTaxDocumentRows,
      billingInvoices: billingInvoiceRows,
      billingPaymentMethods: billingPaymentMethodRows,
      billingWebhookEvents: billingWebhookEventRows,
      reviewQueue,
    },
  };
}

async function rowCount(query: PromiseLike<Array<{ value: number }>>): Promise<number> {
  return (await query)[0]?.value ?? 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function slaStatus(value: string | null): "none" | "due_soon" | "overdue" | "ok" {
  if (!value) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(value);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 1) return "due_soon";
  return "ok";
}

function summarizeSupportTicketAttachments(rows: Array<{
  ticketId: string;
  filename: string;
  archiveUrl: string;
  createdAt: Date;
}>): Map<string, {
  count: number;
  lastAttachmentFilename: string;
  lastAttachmentUrl: string;
}> {
  const summary = new Map<string, {
    count: number;
    lastAttachmentFilename: string;
    lastAttachmentUrl: string;
  }>();
  for (const row of rows) {
    const current = summary.get(row.ticketId);
    if (!current) {
      summary.set(row.ticketId, {
        count: 1,
        lastAttachmentFilename: row.filename,
        lastAttachmentUrl: row.archiveUrl,
      });
    } else {
      current.count += 1;
    }
  }
  return summary;
}

function summarizeSupportTicketMessages(rows: Array<{
  ticketId: string;
  body: string;
  visibility: "public" | "internal";
  createdAt: Date;
}>): Map<string, {
  count: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageVisibility: "public" | "internal";
}> {
  const summary = new Map<string, {
    count: number;
    lastMessageAt: string;
    lastMessagePreview: string;
    lastMessageVisibility: "public" | "internal";
  }>();
  for (const row of rows) {
    const current = summary.get(row.ticketId);
    if (!current) {
      summary.set(row.ticketId, {
        count: 1,
        lastMessageAt: row.createdAt.toISOString(),
        lastMessagePreview: preview(row.body),
        lastMessageVisibility: row.visibility,
      });
    } else {
      current.count += 1;
    }
  }
  return summary;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
