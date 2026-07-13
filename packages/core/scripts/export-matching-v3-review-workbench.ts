import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  renderMatchingV3ReviewWorkbench,
  buildMatchingV3CompanyReviewTasks,
  parseV3AnnotationJsonl,
  type MatchingV3GrantReviewTask,
  type MatchingV3PairReviewTask,
} from "../src/index.js";

const grantTasksPath = resolve(readArg("grant-tasks") ?? "tmp/matching-v3-review-tasks.jsonl");
const pairTasksPath = resolve(readArg("pair-tasks") ?? "tmp/matching-v3-pair-review-tasks.jsonl");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.draft.jsonl");
const outputPath = resolve(readArg("output") ?? "tmp/matching-v3-review-workbench.html");
const includeHoldout = process.argv.includes("--include-holdout");
const grantOnly = process.argv.includes("--grant-only");
if (grantOnly && includeHoldout) throw new Error("--grant-only and --include-holdout are mutually exclusive");
if (includeHoldout && readArg("confirm") !== "BUILD_MATCHING_V3_HOLDOUT_WORKBENCH") {
  throw new Error("holdout workbench requires --confirm=BUILD_MATCHING_V3_HOLDOUT_WORKBENCH");
}
if (existsSync(outputPath) && !process.argv.includes("--force")) {
  throw new Error(`output exists; use --force to replace: ${outputPath}`);
}
const grantTasks = readJsonl<MatchingV3GrantReviewTask>(grantTasksPath);
const pairTasks = grantOnly ? [] : readJsonl<MatchingV3PairReviewTask>(pairTasksPath);
const companyTasks = grantOnly ? [] : buildMatchingV3CompanyReviewTasks(
  parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies,
);
const html = renderMatchingV3ReviewWorkbench({ companyTasks, grantTasks, pairTasks, includeHoldout });
for (const forbidden of ["archive_url", "storage_key", "source_uri", "markdown_storage_key"]) {
  if (html.includes(`\"${forbidden}\"`)) throw new Error(`refusing workbench with forbidden storage field ${forbidden}`);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({
  writeMode: false,
  databaseWrite: false,
  output: outputPath,
  companyTaskCount: companyTasks.length,
  grantTaskCount: grantTasks.length,
  pairTaskCount: includeHoldout ? pairTasks.length : pairTasks.filter((task) => task.annotationTemplate.split === "development").length,
  includeHoldout,
  blindHoldoutPredictions: includeHoldout,
  grantOnly,
  networkAccess: false,
  reminder: "exported reviewed records must still pass repository CLI validators before publication",
}, null, 2));

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; } catch { throw new Error(`${path}:${index + 1}: invalid JSON`); }
  });
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
