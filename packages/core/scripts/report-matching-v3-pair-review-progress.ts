import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseV3AnnotationJsonl,
  RULESET_VERSION,
  SCORING_VERSION,
  type MatchingV3PairReviewTask,
} from "../src/index.js";

const packet = readArg("packet") ?? "small";
if (packet !== "small" && packet !== "expanded") throw new Error("--packet must be small or expanded");
const packetDefaults = packet === "expanded" ? {
  tasks: "tmp/matching-v3-expanded-pair-review-tasks.jsonl",
  annotations: "tmp/matching-v3-expanded-draft-pairs.jsonl",
} : {
  tasks: "tmp/matching-v3-pair-review-tasks.jsonl",
  annotations: "tmp/matching-v3-draft-pairs.jsonl",
};
const tasksPath = resolve(readArg("tasks") ?? packetDefaults.tasks);
const annotationsPath = resolve(readArg("annotations") ?? packetDefaults.annotations);
const tasks = readFileSync(tasksPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  .map((line) => JSON.parse(line) as MatchingV3PairReviewTask);
const pairs = parseV3AnnotationJsonl(readFileSync(annotationsPath, "utf8"), annotationsPath).eligibilityPairs;
const openHoldout = process.argv.includes("--open-holdout");
if (openHoldout && readArg("confirm") !== "OPEN_MATCHING_V3_HOLDOUT") {
  throw new Error("opening holdout metrics requires --confirm=OPEN_MATCHING_V3_HOLDOUT");
}
const expectedTasks = openHoldout
  ? tasks
  : tasks.filter((task) => task.annotationTemplate.split === "development");
const evaluatedPairs = openHoldout ? pairs : pairs.filter((pair) => pair.split === "development");
const taskByPair = new Map(tasks.map((task) => [task.pairId, task]));
const pairById = new Map(pairs.map((pair) => [pair.pairId, pair]));
const missingAnnotations = expectedTasks.filter((task) => !pairs.some((pair) => pair.pairId === task.pairId)).map((task) => task.pairId);
const unknownAnnotations = pairs.filter((pair) => !taskByPair.has(pair.pairId)).map((pair) => pair.pairId);
const reviewed = evaluatedPairs.filter((pair) => pair.labelStatus === "reviewed");
const annotatedDrafts = evaluatedPairs.filter((pair) => pair.labelStatus === "draft" && Boolean(pair.annotatorId && pair.annotatedAt));
const reviewedComparisons = reviewed.map((pair) => ({ pair, task: taskByPair.get(pair.pairId) })).filter((item) => item.task);
const sourceCoverage = new Set(reviewedComparisons.map((item) => item.task!.grantId.split(":")[0]));
const businessKindCounts = histogram(reviewedComparisons.map((item) => item.task!.businessKind));
const agreementCount = reviewedComparisons.filter((item) => item.pair.expectedEligibility === item.task!.predictedEligibility).length;
const evaluatedTaskCount = expectedTasks.length;
const provenanceDrifts = expectedTasks.flatMap((task) => {
  const annotation = pairById.get(task.pairId);
  const reasons: string[] = [];
  if (!task.rulesetVer || !task.scoringVer || !/^[a-f0-9]{64}$/.test(task.inputFingerprint ?? "")) {
    reasons.push("task_provenance_missing");
  }
  if (task.rulesetVer !== RULESET_VERSION || task.scoringVer !== SCORING_VERSION) {
    reasons.push("engine_version_drift");
  }
  if (annotation && (
    annotation.rulesetVer !== task.rulesetVer ||
    annotation.scoringVer !== task.scoringVer ||
    annotation.inputFingerprint !== task.inputFingerprint
  )) reasons.push("annotation_provenance_drift");
  return reasons.length > 0 ? [{ pairId: task.pairId, reasons }] : [];
});
const sliceReady = reviewed.length === evaluatedTaskCount && missingAnnotations.length === 0 && unknownAnnotations.length === 0 &&
  provenanceDrifts.length === 0 &&
  sourceCoverage.has("kstartup") && sourceCoverage.has("bizinfo") &&
  (businessKindCounts.individual ?? 0) > 0 && (businessKindCounts.corporation ?? 0) > 0;
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  writeMode: false,
  packet,
  taskCount: tasks.length,
  annotationCount: pairs.length,
  evaluatedSplit: openHoldout ? "all_including_holdout" : "development",
  evaluatedTaskCount,
  holdoutAnnotationCount: pairs.filter((pair) => pair.split === "holdout").length,
  labelStatusCounts: histogram(pairs.map((pair) => pair.labelStatus)),
  annotatedDraftCount: annotatedDrafts.length,
  reviewedCount: reviewed.length,
  missingAnnotationCount: missingAnnotations.length,
  unknownAnnotationCount: unknownAnnotations.length,
  provenanceDriftCount: provenanceDrifts.length,
  currentEngine: { rulesetVer: RULESET_VERSION, scoringVer: SCORING_VERSION },
  reviewedSourceCoverage: [...sourceCoverage].sort(),
  reviewedBusinessKindCounts: businessKindCounts,
  reviewedPredictionAgreement: ratio(agreementCount, reviewedComparisons.length),
  reviewedConfusionMatrix: confusion(reviewedComparisons.map((item) => ({
    expected: item.pair.expectedEligibility,
    predicted: item.task!.predictedEligibility,
  }))),
  sliceReady,
  missionReady: openHoldout && sliceReady && reviewed.length >= 500,
  operationalReady: openHoldout && sliceReady,
  reminders: [
    "draft engine predictions are excluded from reviewed metrics",
    "sliceReady covers the supplied packet only; first-mission target remains at least 500 reviewed pairs",
    "holdout assignment must be made independently and must not be selected from engine disagreement after review",
  ],
  samples: {
    missingAnnotations: missingAnnotations.slice(0, 10),
    unknownAnnotations: unknownAnnotations.slice(0, 10),
    provenanceDrifts: provenanceDrifts.slice(0, 20),
    reviewedDisagreements: reviewedComparisons
      .filter((item) => item.pair.expectedEligibility !== item.task!.predictedEligibility)
      .slice(0, 20)
      .map((item) => ({
        pairId: item.pair.pairId,
        predicted: item.task!.predictedEligibility,
        reviewed: item.pair.expectedEligibility,
      })),
  },
}, null, 2));

function confusion(values: Array<{ expected: string; predicted: string }>): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const value of values) {
    const row = result[value.expected] ?? {};
    row[value.predicted] = (row[value.predicted] ?? 0) + 1;
    result[value.expected] = row;
  }
  return result;
}
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
