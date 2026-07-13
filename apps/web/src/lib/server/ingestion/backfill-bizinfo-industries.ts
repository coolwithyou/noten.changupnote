import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import {
  planBizInfoIndustryProjectionBackfill,
  planGrantIndustryProjectionBackfill,
} from "./industryProjectionBackfillCore";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 500, 1, 2_000);
const sampleLimit = boundedInteger(readArg("samples"), 30, 0, 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const source = sourceArg(readArg("source"));
const write = process.argv.includes("--write");
const confirmation = readArg("confirm");
const expectedConfirmation = `BACKFILL_${source.toUpperCase()}_INDUSTRIES`;
if (write && confirmation !== expectedConfirmation) {
  throw new Error(`--write requires --confirm=${expectedConfirmation}`);
}

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit, asOf });
  const plan = source === "bizinfo"
    ? planBizInfoIndustryProjectionBackfill(grants)
    : planGrantIndustryProjectionBackfill(grants, source);
  const report = {
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    limit,
    source,
    writeMode: write,
    scanned: plan.scanned,
    sourceCount: plan.sourceCount,
    criteriaSignalCount: plan.criteriaSignalCount,
    candidateCount: plan.candidateCount,
    unchangedCount: plan.unchangedCount,
    candidates: plan.candidates.slice(0, sampleLimit),
  };

  if (!write) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const updated = await db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const candidate of plan.candidates) {
        const rows = await tx
          .update(schema.grants)
          .set({ fIndustries: candidate.after })
          .where(and(
            eq(schema.grants.source, source),
            eq(schema.grants.sourceId, candidate.sourceId),
            eq(schema.grants.fIndustries, candidate.before),
          ))
          .returning({ sourceId: schema.grants.sourceId });
        if (rows.length !== 1) throw new Error(`stale or missing grant: ${source}:${candidate.sourceId}`);
        ids.push(rows[0]!.sourceId);
      }
      return ids;
    });
    console.log(JSON.stringify({ ...report, updatedCount: updated.length, updatedSourceIds: updated }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function sourceArg(value: string | undefined): "bizinfo" | "kstartup" {
  if (!value || value === "bizinfo") return "bizinfo";
  if (value === "kstartup") return value;
  throw new Error(`Invalid source: ${value}`);
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
