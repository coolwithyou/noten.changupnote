import { count, desc, eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

export interface AdminGrantDocumentDraftMetricItem {
  id: string;
  grantId: string;
  companyId: string;
  documentKey: string;
  documentCategory: string;
  documentName: string;
  status: string;
  filledFieldCount: number;
  missingFieldCount: number;
  warningCount: number;
  updatedAt: string;
}

export interface AdminGrantDocumentDraftQualityEventItem {
  id: string;
  draftId: string;
  actorUserId: string;
  kind: string | null;
  documentName: string | null;
  documentCategory: string | null;
  status: string | null;
  hasMessage: boolean;
  createdAt: string;
}

export interface GrantDocumentDraftMetricSummary {
  totalDrafts: number;
  reviewedDrafts: number;
  exportedDrafts: number;
  needsInputDrafts: number;
  totalMissingFields: number;
  averageMissingFields: number;
  qualityFeedbackCount: number;
  qualityFeedbackByKind: Array<{ kind: string; count: number }>;
}

export async function countAdminGrantDocumentDrafts(): Promise<number> {
  try {
    const db = getCunoteDb();
    return await rowCount(db.select({ value: count() }).from(schema.grantDocumentDrafts));
  } catch {
    return 0;
  }
}

export async function countAdminGrantDocumentDraftQualityEvents(): Promise<number> {
  try {
    const db = getCunoteDb();
    return await rowCount(db
      .select({ value: count() })
      .from(schema.grantDocumentDraftEvents)
      .where(eq(schema.grantDocumentDraftEvents.event, "quality_feedback")));
  } catch {
    return 0;
  }
}

export async function listAdminGrantDocumentDraftMetrics(limit = 8): Promise<AdminGrantDocumentDraftMetricItem[]> {
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.grantDocumentDrafts.id,
        grantId: schema.grantDocumentDrafts.grantId,
        companyId: schema.grantDocumentDrafts.companyId,
        documentKey: schema.grantDocumentDrafts.documentKey,
        documentCategory: schema.grantDocumentDrafts.documentCategory,
        documentName: schema.grantDocumentDrafts.documentName,
        status: schema.grantDocumentDrafts.status,
        filledFields: schema.grantDocumentDrafts.filledFields,
        missingFields: schema.grantDocumentDrafts.missingFields,
        warnings: schema.grantDocumentDrafts.warnings,
        updatedAt: schema.grantDocumentDrafts.updatedAt,
      })
      .from(schema.grantDocumentDrafts)
      .orderBy(desc(schema.grantDocumentDrafts.updatedAt))
      .limit(safeLimit(limit));
    return rows.map((row) => ({
      id: row.id,
      grantId: row.grantId,
      companyId: row.companyId,
      documentKey: row.documentKey,
      documentCategory: row.documentCategory,
      documentName: row.documentName,
      status: row.status,
      filledFieldCount: Object.keys(row.filledFields).length,
      missingFieldCount: row.missingFields.length,
      warningCount: row.warnings.length,
      updatedAt: row.updatedAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listAdminGrantDocumentDraftQualityEvents(limit = 8): Promise<AdminGrantDocumentDraftQualityEventItem[]> {
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.grantDocumentDraftEvents.id,
        draftId: schema.grantDocumentDraftEvents.draftId,
        actorUserId: schema.grantDocumentDraftEvents.actorUserId,
        payload: schema.grantDocumentDraftEvents.payload,
        createdAt: schema.grantDocumentDraftEvents.createdAt,
      })
      .from(schema.grantDocumentDraftEvents)
      .where(eq(schema.grantDocumentDraftEvents.event, "quality_feedback"))
      .orderBy(desc(schema.grantDocumentDraftEvents.createdAt))
      .limit(safeLimit(limit));
    return rows.map((row) => ({
      id: row.id,
      draftId: row.draftId,
      actorUserId: row.actorUserId,
      kind: stringValue(row.payload.kind),
      documentName: stringValue(row.payload.documentName),
      documentCategory: stringValue(row.payload.documentCategory),
      status: stringValue(row.payload.status),
      hasMessage: Boolean(stringValue(row.payload.message)),
      createdAt: row.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

export function summarizeAdminGrantDocumentDraftMetrics(input: {
  drafts: AdminGrantDocumentDraftMetricItem[];
  qualityEvents: AdminGrantDocumentDraftQualityEventItem[];
}): GrantDocumentDraftMetricSummary {
  const totalMissingFields = input.drafts.reduce((sum, draft) => sum + draft.missingFieldCount, 0);
  return {
    totalDrafts: input.drafts.length,
    reviewedDrafts: input.drafts.filter((draft) => draft.status === "reviewed").length,
    exportedDrafts: input.drafts.filter((draft) => draft.status === "exported").length,
    needsInputDrafts: input.drafts.filter((draft) => draft.status === "needs_input").length,
    totalMissingFields,
    averageMissingFields: input.drafts.length > 0 ? totalMissingFields / input.drafts.length : 0,
    qualityFeedbackCount: input.qualityEvents.length,
    qualityFeedbackByKind: topKindCounts(input.qualityEvents),
  };
}

async function rowCount(query: Promise<Array<{ value: number }>>): Promise<number> {
  return (await query)[0]?.value ?? 0;
}

function safeLimit(value: number): number {
  return Math.max(1, Math.min(20, value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function topKindCounts(events: AdminGrantDocumentDraftQualityEventItem[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const kind = event.kind ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, itemCount]) => ({ kind, count: itemCount }));
}
