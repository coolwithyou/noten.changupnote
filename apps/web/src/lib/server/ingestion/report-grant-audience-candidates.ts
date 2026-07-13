import { classifyGrantAudience } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 2_000, 1, 2_000);
const sampleLimit = boundedInteger(readArg("sampleLimit"), 30, 1, 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit, asOf });
  const rows = grants.map((entry) => ({
    source: entry.grant.source,
    sourceId: entry.grant.source_id,
    title: entry.grant.title,
    classification: classifyGrantAudience({
      source: entry.grant.source,
      title: entry.grant.title,
      payload: entry.raw.payload,
    }),
    targetSummary: targetSummary(entry.grant.source, entry.raw.payload),
  }));
  const safeIndividual = rows.filter((row) =>
    row.classification.audience === "individual" && row.classification.safeToExcludeFromBusinessMatching);
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    matchingFilterEnabled: false,
    grantCount: rows.length,
    audienceCounts: histogram(rows.map((row) => row.classification.audience)),
    stageCounts: histogram(rows.map((row) => row.classification.stage)),
    bySource: Object.fromEntries([...new Set(rows.map((row) => row.source))].sort().map((source) => [
      source,
      histogram(rows.filter((row) => row.source === source).map((row) => row.classification.audience)),
    ])),
    safeIndividualCandidateCount: safeIndividual.length,
    safeIndividualSamples: sample(safeIndividual, sampleLimit),
    mixedSamples: sample(rows.filter((row) => row.classification.audience === "mixed"), sampleLimit),
    unknownSamples: sample(rows.filter((row) => row.classification.audience === "unknown"), sampleLimit),
    nextGate: "human-reviewed golden individual precision >= 0.95 before DB write or matching exclusion",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function sample<T extends {
  source: string;
  sourceId: string;
  title: string;
  targetSummary: string;
  classification: { confidence: number; stage: string; signals: string[] };
}>(rows: T[], limit: number) {
  return rows.slice(0, limit).map((row) => ({
    source: row.source,
    sourceId: row.sourceId,
    title: row.title,
    targetSummary: row.targetSummary,
    confidence: row.classification.confidence,
    stage: row.classification.stage,
    signals: row.classification.signals,
  }));
}

function targetSummary(source: string, payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  const values = source === "kstartup"
    ? [record.aply_trgt, record.aply_trgt_ctnt]
    : [record.trgetNm, record.bsnsSumryCn];
  const summary = values.filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return summary.length <= 500 ? summary : `${summary.slice(0, 499)}…`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
