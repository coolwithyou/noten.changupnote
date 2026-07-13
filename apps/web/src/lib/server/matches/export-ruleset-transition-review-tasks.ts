import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildMatchingV3GrantReviewTask,
  resolveGrantExtractionManifest,
  RULESET_VERSION,
  SCORING_VERSION,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const planPath = resolve(readArg("plan") ?? "tmp/ruleset-v5-match-state-refresh-plan.json");
const transitionMode = parseTransitionMode(readArg("transition") ?? "restrictive");
const outputStem = transitionMode === "restrictive"
  ? "ruleset-v5-restrictive-transition"
  : transitionMode === "permissive"
    ? "ruleset-v5-permissive-transition"
    : "ruleset-v5-all-transition";
const outputPath = resolve(readArg("output") ?? `tmp/${outputStem}-review-tasks.jsonl`);
const annotationsPath = resolve(
  readArg("annotations-output") ?? `tmp/${outputStem}-draft-annotations.jsonl`,
);
const force = process.argv.includes("--force");
if (!force && (existsSync(outputPath) || existsSync(annotationsPath))) {
  throw new Error("output exists; use --force to replace review artifacts");
}
const plan = parsePlan(JSON.parse(readFileSync(planPath, "utf8")));
if (plan.currentRulesetVer !== RULESET_VERSION || plan.currentScoringVer !== SCORING_VERSION) {
  throw new Error("refresh plan targets a stale ruleset or scoring version");
}
const candidates = plan.transitionReviewGrants.filter((item) => transitionIncluded(item.transition, transitionMode));
if (candidates.length === 0) throw new Error(`refresh plan has no ${transitionMode} transition grants`);

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const tasks = [];
  for (const candidate of candidates) {
    const entry = await repositories.grants.findGrantById(`${candidate.source}:${candidate.sourceId}`);
    if (!entry) throw new Error(`current grant not found: ${candidate.source}:${candidate.sourceId}`);
    if (entry.grant.title !== candidate.title) throw new Error(`refresh review title is stale: ${candidate.sourceId}`);
    const manifest = resolveGrantExtractionManifest(entry);
    const inputSha256 = createHash("sha256").update(JSON.stringify({
      scopeHash: plan.scopeHash,
      revision: manifest.revision,
      criteria: entry.criteria,
    })).digest("hex");
    tasks.push(buildMatchingV3GrantReviewTask(entry, {
      sourceFixture: `ruleset-transition:${transitionMode}:${plan.scopeHash}:${candidate.source}:${candidate.sourceId}`,
      predictedCriteria: entry.criteria,
      predictedRequiredDocuments: entry.grant.required_documents ?? [],
      predictionProvenance: {
        extractorVersion: RULESET_VERSION,
        model: "ruleset-transition-audit",
        inputSha256,
      },
    }));
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(annotationsPath), { recursive: true });
  writeFileSync(outputPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
  writeFileSync(
    annotationsPath,
    `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`,
    "utf8",
  );
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    databaseWriteMode: false,
    companyIdentifiersIncluded: false,
    planPath,
    scopeHash: plan.scopeHash,
    transitionMode,
    transitionCounts: histogram(candidates.map((candidate) => candidate.transition)),
    transitionGrantCount: candidates.length,
    taskCount: tasks.length,
    annotationCount: tasks.length,
    outputPath,
    annotationsPath,
    operationalReady: false,
    nextStep: "Complete independent grant review before authorizing any ruleset match_state write.",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

interface RefreshPlan {
  currentRulesetVer: string;
  currentScoringVer: string;
  scopeHash: string;
  transitionReviewGrants: Array<{
    transition: string;
    source: string;
    sourceId: string;
    title: string;
  }>;
}

function parsePlan(value: unknown): RefreshPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid refresh plan");
  const record = value as Record<string, unknown>;
  if (typeof record.currentRulesetVer !== "string" || typeof record.currentScoringVer !== "string") {
    throw new Error("refresh plan version fields are required");
  }
  if (typeof record.scopeHash !== "string" || !/^[a-f0-9]{64}$/i.test(record.scopeHash)) {
    throw new Error("refresh plan scopeHash must be sha256");
  }
  if (!Array.isArray(record.transitionReviewGrants)) throw new Error("refresh plan review grants are required");
  return {
    currentRulesetVer: record.currentRulesetVer,
    currentScoringVer: record.currentScoringVer,
    scopeHash: record.scopeHash,
    transitionReviewGrants: record.transitionReviewGrants.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`transitionReviewGrants[${index}] must be an object`);
      }
      const row = item as Record<string, unknown>;
      for (const key of ["transition", "source", "sourceId", "title"] as const) {
        if (typeof row[key] !== "string" || !row[key]) {
          throw new Error(`transitionReviewGrants[${index}].${key} is required`);
        }
      }
      return {
        transition: row.transition as string,
        source: row.source as string,
        sourceId: row.sourceId as string,
        title: row.title as string,
      };
    }),
  };
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

type TransitionMode = "restrictive" | "permissive" | "all";

function parseTransitionMode(value: string): TransitionMode {
  if (value === "restrictive" || value === "permissive" || value === "all") return value;
  throw new Error("--transition must be restrictive, permissive, or all");
}

function transitionIncluded(transition: string, mode: TransitionMode): boolean {
  const [previous, next] = transition.split("->");
  const restrictive = next === "ineligible" && previous !== "ineligible";
  const permissive = next === "eligible" && previous !== "eligible";
  return mode === "all" ? restrictive || permissive : mode === "restrictive" ? restrictive : permissive;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
