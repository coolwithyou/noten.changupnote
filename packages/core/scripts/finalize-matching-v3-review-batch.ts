import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMatchingV3CompanyReviewTasks,
  parseV3AnnotationJsonl,
  validateMatchingV3ReviewBatch,
  type MatchingV3GrantReviewTask,
  type MatchingV3PairReviewTask,
} from "../src/index.js";

const companiesPath = requiredArg("companies");
const grantsPath = requiredArg("grants");
const pairsPath = requiredArg("pairs");
const packet = readArg("packet") ?? "small";
if (packet !== "small" && packet !== "expanded") throw new Error("--packet must be small or expanded");
const stage = readArg("stage") ?? "reviewed";
if (stage !== "annotated" && stage !== "reviewed") throw new Error("--stage must be annotated or reviewed");
const includeHoldout = process.argv.includes("--include-holdout");
if (includeHoldout && readArg("holdout-confirm") !== "OPEN_MATCHING_V3_HOLDOUT") {
  throw new Error("holdout batch requires --holdout-confirm=OPEN_MATCHING_V3_HOLDOUT");
}
const write = process.argv.includes("--write");
if (write && stage !== "reviewed") throw new Error("only reviewed batches can be finalized");
if (write && readArg("confirm") !== "FINALIZE_MATCHING_V3_REVIEW_BATCH") {
  throw new Error("write requires --confirm=FINALIZE_MATCHING_V3_REVIEW_BATCH");
}
const packetDefaults = packet === "expanded" ? {
  originalCompanies: "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl",
  grantTasks: "tmp/matching-v3-expanded-grant-review-tasks.jsonl",
  pairTasks: "tmp/matching-v3-expanded-pair-review-tasks.jsonl",
  outputDir: "packages/core/golden/matching-v3/reviewed-expanded",
} : {
  originalCompanies: "packages/core/golden/matching-v3/company-profiles.draft.jsonl",
  grantTasks: "tmp/matching-v3-review-tasks.jsonl",
  pairTasks: "tmp/matching-v3-pair-review-tasks.jsonl",
  outputDir: "packages/core/golden/matching-v3/reviewed",
};
const originalCompaniesPath = resolve(readArg("company-tasks-source") ?? packetDefaults.originalCompanies);
const grantTasksPath = resolve(readArg("grant-tasks") ?? packetDefaults.grantTasks);
const pairTasksPath = resolve(readArg("pair-tasks") ?? packetDefaults.pairTasks);
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies;
const grants = parseV3AnnotationJsonl(readFileSync(grantsPath, "utf8"), grantsPath).grants;
const pairs = parseV3AnnotationJsonl(readFileSync(pairsPath, "utf8"), pairsPath).eligibilityPairs;
const originalCompanies = parseV3AnnotationJsonl(readFileSync(originalCompaniesPath, "utf8"), originalCompaniesPath).companies;
const grantTasks = readJsonl<MatchingV3GrantReviewTask>(grantTasksPath);
const pairTasks = readJsonl<MatchingV3PairReviewTask>(pairTasksPath);
const report = validateMatchingV3ReviewBatch({
  companies,
  grants,
  pairs,
  companyTasks: buildMatchingV3CompanyReviewTasks(originalCompanies),
  grantTasks,
  pairTasks,
  stage,
  includeHoldout,
});
if (!report.batchReady) {
  console.error(JSON.stringify({
    writeMode: write,
    ...report,
    errorCount: report.errors.length,
    errors: report.errors.slice(0, 100),
  }, null, 2));
  process.exitCode = 1;
} else {
  const outputDir = resolve(readArg("output-dir") ?? packetDefaults.outputDir);
  const outputs = {
    companies: resolve(outputDir, "company-profiles.jsonl"),
    grants: resolve(outputDir, "grants.jsonl"),
    developmentPairs: resolve(outputDir, "eligibility-pairs.development.jsonl"),
    ...(includeHoldout ? { holdoutPairs: resolve(outputDir, "eligibility-pairs.holdout.jsonl") } : {}),
  };
  if (write) {
    mkdirSync(outputDir, { recursive: true });
    if (!process.argv.includes("--force")) {
      const existing = Object.values(outputs).filter(existsSync);
      if (existing.length > 0) throw new Error(`refusing overwrite without --force: ${existing.join(", ")}`);
    }
    writeJsonl(outputs.companies, companies);
    writeJsonl(outputs.grants, grants);
    writeJsonl(outputs.developmentPairs, pairs.filter((pair) => pair.split === "development"));
    if (includeHoldout && "holdoutPairs" in outputs) writeJsonl(outputs.holdoutPairs, pairs.filter((pair) => pair.split === "holdout"));
  }
  console.log(JSON.stringify({
    writeMode: write,
    packet,
    ...report,
    outputDir,
    outputs,
    finalizedCount: write ? report.companyCount + report.grantCount + report.pairCount : 0,
    databaseWrite: false,
    reminder: "reviewed fixture finalization does not publish grant criteria or mutate match_state",
  }, null, 2));
}

function requiredArg(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`--${name}=<path> is required`);
  return resolve(value);
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
