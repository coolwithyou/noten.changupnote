import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 2_000, 1, 2_000);
const sampleLimit = boundedInteger(readArg("sampleLimit"), 20, 1, 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const currentYear = asOf.getUTCFullYear();
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit, asOf });
  const rows = grants.map((entry) => {
    const titleYears = extractYears(entry.grant.title);
    const newestTitleYear = titleYears.length > 0 ? Math.max(...titleYears) : null;
    const applyEnd = date(entry.grant.apply_end);
    const staleTitleYear = applyEnd === null && newestTitleYear !== null && newestTitleYear <= currentYear - 2;
    return {
      source: entry.grant.source,
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      status: entry.grant.status,
      applyStart: entry.grant.apply_start ?? null,
      applyEnd: entry.grant.apply_end ?? null,
      newestTitleYear,
      staleTitleYear,
    };
  });
  const sources = [...new Set(rows.map((row) => row.source))].sort();
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    activeUniverseGuardEnabled: true,
    reportedRowsAlreadyGuarded: true,
    grantCount: rows.length,
    missingApplyEndCount: rows.filter((row) => row.applyEnd === null).length,
    staleTitleYearCandidateCount: rows.filter((row) => row.staleTitleYear).length,
    bySource: Object.fromEntries(sources.map((source) => {
      const sourceRows = rows.filter((row) => row.source === source);
      return [source, {
        grants: sourceRows.length,
        missingApplyEnd: sourceRows.filter((row) => row.applyEnd === null).length,
        staleTitleYearCandidates: sourceRows.filter((row) => row.staleTitleYear).length,
        statusCounts: histogram(sourceRows.map((row) => row.status)),
        titleYearCounts: histogram(sourceRows.flatMap((row) =>
          row.newestTitleYear === null ? ["missing"] : [String(row.newestTitleYear)])),
      }];
    })),
    staleTitleYearSamples: rows.filter((row) => row.staleTitleYear).slice(0, sampleLimit),
    missingDeadlineSamples: rows.filter((row) => row.applyEnd === null && !row.staleTitleYear).slice(0, sampleLimit),
    nextGate: "review stale samples before any active-universe exclusion or status backfill",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function extractYears(value: string): number[] {
  return [...value.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1990 && year <= 2100);
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
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
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}
