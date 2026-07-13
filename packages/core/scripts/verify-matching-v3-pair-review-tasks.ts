import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseV3AnnotationJsonl, type MatchingV3PairReviewTask } from "../src/index.js";

const tasksPath = resolve(readArg("input") ?? "tmp/matching-v3-pair-review-tasks.jsonl");
const annotationsPath = resolve(readArg("annotations") ?? "tmp/matching-v3-draft-pairs.jsonl");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.draft.jsonl");
const tasks = readFileSync(tasksPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  .map((line) => JSON.parse(line) as MatchingV3PairReviewTask);
const annotations = parseV3AnnotationJsonl(readFileSync(annotationsPath, "utf8"), annotationsPath);
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath);

assert.equal(companies.companies.length, 3);
assert.equal(companies.companies.filter((company) => company.businessKind === "individual").length, 2);
assert.equal(companies.companies.filter((company) => company.businessKind === "corporation").length, 1);
assert.equal(companies.companies.every((company) => company.labelStatus === "draft"), true);
assert.equal(tasks.length, 90, "30 grants x 3 companies");
assert.equal(new Set(tasks.map((task) => task.pairId)).size, 90);
assert.equal(new Set(tasks.map((task) => task.grantId)).size, 30);
assert.equal(new Set(tasks.map((task) => task.companyId)).size, 3);
assert.equal(tasks.every((task) => task.annotationTemplate.labelStatus === "draft"), true);
assert.equal(tasks.every((task) => task.annotationTemplate.note === "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW"), true);
assert.equal(tasks.every((task) => task.annotationTemplate.expectedEligibility === task.predictedEligibility), true);
assert.equal(tasks.every((task) => Boolean(task.grantSourceRevision)), true);
assert.equal(annotations.eligibilityPairs.length, 90);
assert.equal(annotations.eligibilityPairs.every((pair) => pair.labelStatus === "draft"), true);
assert.equal(annotations.eligibilityPairs.filter((pair) => pair.labelStatus === "reviewed").length, 0);
assert.equal(annotations.eligibilityPairs.filter((pair) => pair.split === "development").length, 63);
assert.equal(annotations.eligibilityPairs.filter((pair) => pair.split === "holdout").length, 27);
const serialized = JSON.stringify(tasks);
for (const forbidden of ["company_value", "bizNo", "businessNumber", "representativeName", "rawPayload"]) {
  assert.equal(serialized.includes(`\"${forbidden}\"`), false, `forbidden pair task field ${forbidden}`);
}
console.log(JSON.stringify({
  ok: true,
  checked: [
    "synthetic_company_profile_count",
    "individual_corporation_strata",
    "pair_cross_product_count",
    "pair_id_uniqueness",
    "pair_task_redaction",
    "engine_prediction_draft_only",
    "pair_annotation_contract",
    "reviewed_count_zero",
    "preassigned_holdout_30_percent",
  ],
  companies: companies.companies.length,
  grants: new Set(tasks.map((task) => task.grantId)).size,
  pairs: tasks.length,
  predictedEligibility: histogram(tasks.map((task) => task.predictedEligibility)),
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
