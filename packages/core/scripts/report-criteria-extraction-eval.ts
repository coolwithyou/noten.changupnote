import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateCriterionExtraction,
  parseV3AnnotationJsonl,
  type MatchingV3GrantReviewTask,
  type V3LabelStatus,
} from "../src/index.js";

const annotationPath = resolve(readArg("annotations") ?? "packages/core/golden/matching-v3/grants.jsonl");
const predictionPath = resolve(readArg("predictions") ?? "tmp/matching-v3-review-tasks.jsonl");
const labelStatus = labelStatusArg(readArg("labelStatus"));
const verify = process.argv.includes("--verify");

const unavailable = [annotationPath, predictionPath].filter((path) => !existsSync(path));
if (unavailable.length > 0) {
  const result = {
    operationalReady: false,
    requiredLabelStatus: labelStatus,
    reason: "required_input_missing",
    missingFiles: unavailable,
    nextStep: "review task의 annotationTemplate을 검수·수정한 뒤 grants.jsonl로 저장하세요.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (verify) process.exitCode = 1;
} else {
  const annotations = parseV3AnnotationJsonl(readFileSync(annotationPath, "utf8"), annotationPath);
  const tasks = readFileSync(predictionPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MatchingV3GrantReviewTask);
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
    { labelStatus },
  );
  const gates = qualityGates(report);
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    annotations: annotationPath,
    predictions: predictionPath,
    ...report,
    gates,
  }, null, 2));
  if (verify && (!report.operationalReady || gates.some((gate) => !gate.pass))) process.exitCode = 1;
}

function qualityGates(report: ReturnType<typeof evaluateCriterionExtraction>) {
  return [
    metricGate("required_recall", report.byKind.required?.recall ?? null, 0.9),
    metricGate("exclusion_recall", report.byKind.exclusion?.recall ?? null, 0.95),
    metricGate("gold_evidence_coverage", report.goldEvidenceCoverage, 1),
  ];
}

function metricGate(name: string, actual: number | null, minimum: number) {
  return { name, actual, minimum, pass: actual !== null && actual >= minimum };
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function labelStatusArg(value: string | undefined): V3LabelStatus {
  if (value === undefined || value === "reviewed") return "reviewed";
  if (value === "draft" || value === "legacy") return value;
  throw new Error(`Invalid labelStatus: ${value}`);
}
