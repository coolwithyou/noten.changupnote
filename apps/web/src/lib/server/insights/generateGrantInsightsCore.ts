// 공고 아카이브 인사이트 스냅샷 생성 코어. 선택된 DB 에서 grants/criteria/cursor/활동 카운트를 읽어
// 스냅샷을 집계하고, write 이면 grant_insight_snapshots 에 저장한다.
//
// 이 모듈은 순수 코어다: argv/env 파싱과 loadMonorepoEnv, db 생성은 호출부(CLI · API 라우트)의 책임이며,
// 여기서는 process.env 가 이미 주입돼 있다고 가정한다.
// CLI 는 generate-grant-insights.ts, 서버 라우트는 /api/cron/grant-cycle-post 가 이 함수를 호출한다.
import { count, sql } from "drizzle-orm";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  buildGrantInsightSnapshot,
  type GrantInsightActivityCounts,
} from "./grantInsights";

export interface RunGrantInsightsInput {
  db: CunoteDb;
  write: boolean;
  asOf: Date;
  staleCursorHours: number;
}

export async function runGrantInsights(input: RunGrantInsightsInput): Promise<Record<string, unknown>> {
  const { db } = input;
  await db.execute(sql`set statement_timeout = '30s'`);
  const grants = await db
    .select({
      source: schema.grants.source,
      status: schema.grants.status,
      categoryL1: schema.grants.categoryL1,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      applyStart: schema.grants.applyStart,
      applyEnd: schema.grants.applyEnd,
      fRegions: schema.grants.fRegions,
      overallConfidence: schema.grants.overallConfidence,
      updatedAt: schema.grants.updatedAt,
    })
    .from(schema.grants);
  const criteria = await db
    .select({
      dimension: schema.grantCriteria.dimension,
      operator: schema.grantCriteria.operator,
      kind: schema.grantCriteria.kind,
      confidence: schema.grantCriteria.confidence,
      needsReview: schema.grantCriteria.needsReview,
    })
    .from(schema.grantCriteria);
  const cursors = await db
    .select({
      source: schema.sourceCursor.source,
      lastPage: schema.sourceCursor.lastPage,
      lastCollectedAt: schema.sourceCursor.lastCollectedAt,
    })
    .from(schema.sourceCursor);
  const activity = await readActivityCounts(db);
  const snapshot = buildGrantInsightSnapshot({
    asOf: input.asOf,
    staleCursorHours: input.staleCursorHours,
    grants,
    criteria,
    cursors,
    activity,
  });

  if (input.write) {
    const [row] = await db
      .insert(schema.grantInsightSnapshots)
      .values({
        kind: snapshot.kind,
        windowStart: snapshot.windowStart ? new Date(snapshot.windowStart) : null,
        windowEnd: new Date(snapshot.windowEnd),
        generatedAt: new Date(snapshot.generatedAt),
        metrics: snapshot.metrics,
        dimensions: snapshot.dimensions,
        insights: snapshot.insights as unknown as Array<Record<string, unknown>>,
      })
      .returning({ id: schema.grantInsightSnapshots.id });
    return {
      dryRun: false,
      snapshotId: row?.id ?? null,
      ...snapshot,
    };
  }

  return {
    dryRun: true,
    ...snapshot,
  };
}

async function readActivityCounts(db: CunoteDb): Promise<GrantInsightActivityCounts> {
  return {
    dedupLinks: await rowCount(db.select({ value: count() }).from(schema.dedupLinks)),
    extractionLog: await rowCount(db.select({ value: count() }).from(schema.extractionLog)),
    feedback: await rowCount(db.select({ value: count() }).from(schema.feedback)),
    matchEvents: await rowCount(db.select({ value: count() }).from(schema.matchEvents)),
    goldenSet: await rowCount(db.select({ value: count() }).from(schema.goldenSet)),
    evalRuns: await rowCount(db.select({ value: count() }).from(schema.evalRuns)),
  };
}

async function rowCount(query: PromiseLike<Array<{ value: number }>>): Promise<number> {
  return (await query)[0]?.value ?? 0;
}
