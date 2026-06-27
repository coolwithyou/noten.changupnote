import {
  findGrantDedupCandidates,
  type FindGrantDedupCandidatesOptions,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import {
  planDedupLinkPublication,
  publishDedupLinks,
} from "./dedupLinkPublisher";

loadMonorepoEnv();

if (hasFlag("help")) {
  console.log([
    "Usage: pnpm publish:dedup -- [--dry-run] [--limit=500] [--minScore=0.82] [--asOf=2026-06-27T00:00:00.000Z]",
    "",
    "Reads active grants as of --asOf, plans cross-source dedup links, and persists them unless --dry-run is set.",
  ].join("\n"));
  process.exit(0);
}

const dryRun = hasFlag("dry-run") || process.env.CUNOTE_DEDUP_DRY_RUN === "true";
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_DEDUP_LIMIT, 500, 1, 2_000);
const minScore = optionalNumber(readArg("minScore") ?? process.env.CUNOTE_DEDUP_MIN_SCORE);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_DEDUP_AS_OF) ?? new Date();
const options = dedupOptions(minScore);
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({
    dialect: "drizzle",
    client: db,
  });
  const entries = await repositories.grants.listActiveGrants({ limit, asOf });
  const candidates = findGrantDedupCandidates(entries, options);
  const plan = planDedupLinkPublication(candidates);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      asOf: asOf.toISOString(),
      activeGrantCount: entries.length,
      minScore: options.minScore ?? null,
      ...plan,
    }, null, 2));
  } else {
    const result = await publishDedupLinks(db, candidates);
    console.log(JSON.stringify({
      dryRun: false,
      asOf: asOf.toISOString(),
      activeGrantCount: entries.length,
      minScore: options.minScore ?? null,
      ...result,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function dedupOptions(minScore: number | undefined): FindGrantDedupCandidatesOptions {
  const options: FindGrantDedupCandidatesOptions = {};
  if (minScore !== undefined) options.minScore = minScore;
  return options;
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

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid minScore: ${value}. Use 0..1.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
