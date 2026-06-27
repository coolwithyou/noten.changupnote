import { count } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  buildGrantInsightSnapshot,
  type GrantInsightActivityCounts,
} from "./grantInsights";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const write = hasFlag("write") || process.env.CUNOTE_GRANT_INSIGHTS_WRITE === "true";
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_GRANT_INSIGHTS_AS_OF) ?? new Date();
const staleCursorHours = boundedInteger(
  readArg("staleCursorHours") ?? process.env.CUNOTE_GRANT_INSIGHTS_STALE_CURSOR_HOURS,
  48,
  1,
  24 * 30,
);
const db = getCunoteDb();

try {
  const [grants, criteria, cursors, activity] = await Promise.all([
    db
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
      .from(schema.grants),
    db
      .select({
        dimension: schema.grantCriteria.dimension,
        operator: schema.grantCriteria.operator,
        kind: schema.grantCriteria.kind,
        confidence: schema.grantCriteria.confidence,
        needsReview: schema.grantCriteria.needsReview,
      })
      .from(schema.grantCriteria),
    db
      .select({
        source: schema.sourceCursor.source,
        lastPage: schema.sourceCursor.lastPage,
        lastCollectedAt: schema.sourceCursor.lastCollectedAt,
      })
      .from(schema.sourceCursor),
    readActivityCounts(),
  ]);
  const snapshot = buildGrantInsightSnapshot({
    asOf,
    staleCursorHours,
    grants,
    criteria,
    cursors,
    activity,
  });

  if (write) {
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
    console.log(JSON.stringify({
      dryRun: false,
      snapshotId: row?.id ?? null,
      ...snapshot,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      dryRun: true,
      ...snapshot,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

async function readActivityCounts(): Promise<GrantInsightActivityCounts> {
  const [
    dedupLinks,
    extractionLog,
    feedback,
    matchEvents,
    goldenSet,
    evalRuns,
  ] = await Promise.all([
    rowCount(db.select({ value: count() }).from(schema.dedupLinks)),
    rowCount(db.select({ value: count() }).from(schema.extractionLog)),
    rowCount(db.select({ value: count() }).from(schema.feedback)),
    rowCount(db.select({ value: count() }).from(schema.matchEvents)),
    rowCount(db.select({ value: count() }).from(schema.goldenSet)),
    rowCount(db.select({ value: count() }).from(schema.evalRuns)),
  ]);

  return {
    dedupLinks,
    extractionLog,
    feedback,
    matchEvents,
    goldenSet,
    evalRuns,
  };
}

async function rowCount(query: PromiseLike<Array<{ value: number }>>): Promise<number> {
  return (await query)[0]?.value ?? 0;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function printHelp() {
  console.log(`Usage: pnpm insights:grants -- [options]

Builds a grant archive insight snapshot from the selected database.
Default mode is dry-run. Add --write to persist grant_insight_snapshots.

Options:
  --write
  --asOf=2026-06-27T00:00:00Z
  --staleCursorHours=48
`);
}
