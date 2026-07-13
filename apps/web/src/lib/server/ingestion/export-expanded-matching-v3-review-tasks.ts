import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildMatchingV3GrantReviewTask,
  resolveGrantExtractionManifest,
  selectExpandedGrantReviewCandidates,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const output = resolve(readArg("output") ?? "tmp/matching-v3-expanded-grant-review-tasks.jsonl");
const annotationsOutput = resolve(readArg("annotations-output") ?? "tmp/matching-v3-expanded-draft-grants.jsonl");
const manifestOutput = resolve(readArg("manifest-output") ?? "packages/core/golden/matching-v3/expanded-seed-manifest.json");
const limit = boundedInteger(readArg("limit"), 2_000, 100, 5_000);
const perSource = boundedInteger(readArg("per-source"), 50, 10, 500);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const force = process.argv.includes("--force");
if (!force && [output, annotationsOutput, manifestOutput].some(existsSync)) {
  throw new Error("output exists; use --force to replace expanded review artifacts");
}
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const active = await repositories.grants.listActiveGrants({ limit, asOf });
  if (active.length >= limit) throw new Error(`active universe may be truncated at limit=${limit}; increase --limit`);
  const selection = selectExpandedGrantReviewCandidates({ entries: active, perSource });
  const tasks = selection.entries.map((entry) => buildMatchingV3GrantReviewTask(entry));
  const manifest = {
    schemaVersion: "matching-v3-expanded-seed-v1",
    createdAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    selectionMethod: "source_quota_then_readiness_and_criterion_risk",
    activeUniverseCount: active.length,
    activeUniverseLimit: limit,
    activeUniverseComplete: true,
    perSource,
    companyFixture: "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl",
    companyCount: 30,
    grantSelection: tasks.map((task) => ({
      grantId: task.grantId,
      source: task.source,
      sourceId: task.sourceId,
      title: task.title,
      sourceRevision: task.annotationTemplate.sourceRevision,
      readiness: task.readiness,
      status: "draft_pending",
    })),
  };
  for (const path of [output, annotationsOutput, manifestOutput]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(output, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
  writeFileSync(annotationsOutput, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
  writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    writeMode: false,
    databaseWrite: false,
    activeUniverseCount: active.length,
    activeUniverseComplete: true,
    grantTaskCount: tasks.length,
    bySource: selection.bySource,
    byReadinessGroup: selection.byReadinessGroup,
    dimensionCounts: selection.dimensionCounts,
    readinessCounts: histogram(tasks.map((task) => task.readiness)),
    output,
    annotationsOutput,
    manifestOutput,
    reviewedCount: 0,
    operationalReady: false,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`value must be ${min}..${max}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date ${value}`);
  return date;
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
