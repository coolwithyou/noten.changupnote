import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  applyPairHoldoutManifest,
  buildMatchingV3PairHoldoutManifest,
  buildMatchingV3PairReviewTasks,
  parseV3AnnotationJsonl,
  selectExpandedPairReviewCandidates,
} from "../src/index.js";

const grantsPath = resolve(readArg("grants") ?? "tmp/matching-v3-expanded-draft-grants.jsonl");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl");
const output = resolve(readArg("output") ?? "tmp/matching-v3-expanded-pair-review-tasks.jsonl");
const annotationsOutput = resolve(readArg("annotations-output") ?? "tmp/matching-v3-expanded-draft-pairs.jsonl");
const developmentOutput = resolve(readArg("development-output") ?? "tmp/matching-v3-expanded-draft-pairs.development.jsonl");
const holdoutOutput = resolve(readArg("holdout-output") ?? "tmp/matching-v3-expanded-draft-pairs.holdout.jsonl");
const holdoutManifestOutput = resolve(readArg("holdout-manifest-output") ?? "packages/core/golden/matching-v3/expanded-holdout-manifest.json");
const targetCount = boundedInteger(readArg("target"), 500, 100, 5_000);
const force = process.argv.includes("--force");
if (!force && [output, annotationsOutput, developmentOutput, holdoutOutput, holdoutManifestOutput].some(existsSync)) {
  throw new Error("output exists; use --force to replace expanded pair artifacts");
}
const grants = parseV3AnnotationJsonl(readFileSync(grantsPath, "utf8"), grantsPath).grants;
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies;
const allTasks = buildMatchingV3PairReviewTasks({ grants, companies });
const selection = selectExpandedPairReviewCandidates({ tasks: allTasks, targetCount });
const holdoutManifest = buildMatchingV3PairHoldoutManifest({ tasks: selection.tasks, targetRatio: 0.3 });
const tasks = applyPairHoldoutManifest(selection.tasks, holdoutManifest);
const development = tasks.filter((task) => task.annotationTemplate.split === "development");
const holdout = tasks.filter((task) => task.annotationTemplate.split === "holdout");
for (const path of [output, annotationsOutput, developmentOutput, holdoutOutput, holdoutManifestOutput]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(output, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
writeFileSync(annotationsOutput, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
writeFileSync(developmentOutput, `${development.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
writeFileSync(holdoutOutput, `${holdout.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
writeFileSync(holdoutManifestOutput, `${JSON.stringify(holdoutManifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  writeMode: false,
  databaseWrite: false,
  grantCount: grants.length,
  companyCount: companies.length,
  crossProductCount: allTasks.length,
  selectedPairCount: tasks.length,
  developmentCount: development.length,
  holdoutCount: holdout.length,
  bySource: selection.bySource,
  byBusinessKind: selection.byBusinessKind,
  byPredictedEligibility: selection.byPredictedEligibility,
  grantCoverage: selection.grantCoverage,
  companyCoverage: selection.companyCoverage,
  output,
  annotationsOutput,
  developmentOutput,
  holdoutOutput,
  holdoutManifestOutput,
  reviewedCount: 0,
  operationalReady: false,
}, null, 2));

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`target must be ${min}..${max}`);
  return parsed;
}
