import { count, desc } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface AdminFlywheelSnapshot {
  generatedAt: string;
  counts: {
    extractionLog: number;
    feedback: number;
    matchEvents: number;
    goldenSet: number;
    evalRuns: number;
    grantInsightSnapshots: number;
  };
  recent: {
    extractionLog: AdminExtractionLogItem[];
    feedback: AdminFeedbackItem[];
    matchEvents: AdminMatchEventItem[];
    goldenSet: AdminGoldenSetItem[];
    evalRuns: AdminEvalRunItem[];
    grantInsightSnapshots: AdminGrantInsightSnapshotItem[];
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
  ts: string;
}

export interface AdminGrantInsightSnapshotItem {
  id: string;
  kind: string;
  generatedAt: string;
  metricKeys: string[];
  insightCount: number;
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
    extractionRows,
    feedbackRows,
    matchEventRows,
    goldenRows,
    evalRows,
    grantInsightSnapshotRows,
  ] = await Promise.all([
    rowCount(db.select({ value: count() }).from(schema.extractionLog)),
    rowCount(db.select({ value: count() }).from(schema.feedback)),
    rowCount(db.select({ value: count() }).from(schema.matchEvents)),
    rowCount(db.select({ value: count() }).from(schema.goldenSet)),
    rowCount(db.select({ value: count() }).from(schema.evalRuns)),
    rowCount(db.select({ value: count() }).from(schema.grantInsightSnapshots)),
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
  ]);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      extractionLog: extractionCount,
      feedback: feedbackCount,
      matchEvents: matchEventCount,
      goldenSet: goldenCount,
      evalRuns: evalCount,
      grantInsightSnapshots: grantInsightSnapshotCount,
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
        ts: row.ts.toISOString(),
      })),
      grantInsightSnapshots: grantInsightSnapshotRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        generatedAt: row.generatedAt.toISOString(),
        metricKeys: Object.keys(row.metrics).sort(),
        insightCount: row.insights.length,
      })),
    },
  };
}

async function rowCount(query: PromiseLike<Array<{ value: number }>>): Promise<number> {
  return (await query)[0]?.value ?? 0;
}
