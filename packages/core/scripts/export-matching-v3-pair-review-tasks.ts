import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  applyPairHoldoutManifest,
  buildMatchingV3PairReviewTasks,
  parseV3AnnotationJsonl,
  type MatchingV3PairHoldoutManifest,
} from "../src/index.js";

const grantsPath = resolve(readArg("grants") ?? "tmp/matching-v3-draft-grants.jsonl");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.draft.jsonl");
const holdoutManifestPath = resolve(readArg("holdout-manifest") ?? "packages/core/golden/matching-v3/holdout-manifest.json");
const outputPath = resolve(readArg("output") ?? "tmp/matching-v3-pair-review-tasks.jsonl");
const annotationsPath = resolve(readArg("annotations-output") ?? "tmp/matching-v3-draft-pairs.jsonl");
const developmentAnnotationsPath = resolve(readArg("development-annotations-output") ?? "tmp/matching-v3-draft-pairs.development.jsonl");
const holdoutAnnotationsPath = resolve(readArg("holdout-annotations-output") ?? "tmp/matching-v3-draft-pairs.holdout.jsonl");
const force = process.argv.includes("--force");
if (!force && [outputPath, annotationsPath, developmentAnnotationsPath, holdoutAnnotationsPath].some(existsSync)) {
  throw new Error("output already exists; use --force to replace generated review files");
}
const grants = parseV3AnnotationJsonl(readFileSync(grantsPath, "utf8"), grantsPath).grants;
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies;
if (grants.length === 0) throw new Error("at least one grant annotation is required");
if (companies.length === 0) throw new Error("at least one company annotation is required");
const holdoutManifest = JSON.parse(readFileSync(holdoutManifestPath, "utf8")) as MatchingV3PairHoldoutManifest;
const tasks = applyPairHoldoutManifest(buildMatchingV3PairReviewTasks({ grants, companies }), holdoutManifest);
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(annotationsPath), { recursive: true });
mkdirSync(dirname(developmentAnnotationsPath), { recursive: true });
mkdirSync(dirname(holdoutAnnotationsPath), { recursive: true });
writeFileSync(outputPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
writeFileSync(annotationsPath, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
writeFileSync(developmentAnnotationsPath, `${tasks.filter((task) => task.annotationTemplate.split === "development").map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
writeFileSync(holdoutAnnotationsPath, `${tasks.filter((task) => task.annotationTemplate.split === "holdout").map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  writeMode: false,
  databaseWrite: false,
  grantCount: grants.length,
  companyCount: companies.length,
  pairTaskCount: tasks.length,
  splitCounts: histogram(tasks.map((task) => task.annotationTemplate.split)),
  predictedEligibility: histogram(tasks.map((task) => task.predictedEligibility)),
  byBusinessKind: histogram(tasks.map((task) => task.businessKind)),
  output: outputPath,
  annotationsOutput: annotationsPath,
  developmentAnnotationsOutput: developmentAnnotationsPath,
  holdoutAnnotationsOutput: holdoutAnnotationsPath,
  operationalReady: false,
  reminder: "engine predictions are draft review aids, not eligibility ground truth",
}, null, 2));

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
