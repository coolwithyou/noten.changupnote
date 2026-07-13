import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateCriterionExtraction,
  parseV3AnnotationJsonl,
  type MatchingV3GrantReviewTask,
} from "../src/index.js";

const input = resolve(readArg("input") ?? "tmp/matching-v3-review-tasks.jsonl");
const lines = readFileSync(input, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const tasks = lines.map((line, index) => {
  const parsed = JSON.parse(line) as MatchingV3GrantReviewTask;
  assert.equal(parsed.recordType, "grant_review_task", `line ${index + 1} recordType`);
  assert.equal(parsed.schemaVersion, "matching-v3-review-task-v1", `line ${index + 1} schemaVersion`);
  return parsed;
});

assert.equal(tasks.length, 30);
assert.equal(new Set(tasks.map((task) => task.grantId)).size, 30);
assert.equal(tasks.filter((task) => task.source === "kstartup").length, 20);
assert.equal(tasks.filter((task) => task.source === "bizinfo").length, 10);
assert.equal(tasks.every((task) => task.annotationTemplate.labelStatus === "draft"), true);
assert.equal(tasks.every((task) => task.annotationTemplate.reviewerId === null), true);
assert.equal(tasks.every((task) => Boolean(task.annotationTemplate.sourceRevision?.trim())), true);

const forbiddenKeys = new Set([
  "url",
  "archive_url",
  "storage_key",
  "source_uri",
  "markdown_url",
  "markdown_storage_key",
  "sha256",
]);
for (const task of tasks) {
  assert.deepEqual(findForbiddenKeys(task, forbiddenKeys), [], `${task.grantId} must not expose storage or raw URLs`);
}

const annotations = parseV3AnnotationJsonl(
  tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n"),
  input,
);
assert.equal(annotations.grants.length, 30);

const report = evaluateCriterionExtraction(
  annotations.grants,
  tasks.map((task) => ({
    grantId: task.grantId,
    criteria: task.predictedCriteria.map((criterion) => ({
      id: criterion.criterionId,
      dimension: criterion.dimension,
      kind: criterion.kind,
      operator: criterion.operator,
      value: criterion.value as Record<string, unknown>,
      confidence: criterion.confidence,
      ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
      ...(criterion.sourceField ? { source_field: criterion.sourceField } : {}),
      ...(criterion.needsReview ? { needs_review: true } : {}),
    })),
  })),
);
assert.equal(report.operationalReady, false, "draft templates must not produce operational recall");
assert.equal(report.evaluatedGrantCount, 0);
assert.equal(report.overall.recall, null);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "review_task_count",
    "review_task_source_strata",
    "review_task_unique_grants",
    "review_task_redaction",
    "annotation_template_contract",
    "annotation_source_revision_pinned",
    "draft_excluded_from_operational_metrics",
  ],
  taskCount: tasks.length,
  readiness: histogram(tasks.map((task) => task.readiness)),
}, null, 2));

function findForbiddenKeys(value: unknown, forbidden: Set<string>, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, forbidden, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(forbidden.has(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(item, forbidden, path ? `${path}.${key}` : key),
  ]);
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
