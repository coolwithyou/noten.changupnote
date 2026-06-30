import assert from "node:assert/strict";
import {
  buildMatchingEvalVersionRefs,
  computeMatchingEvalMetrics,
  type MatchingEvalObservation,
} from "./matchingEval";

const observations: MatchingEvalObservation[] = [
  observation({
    goldenId: "golden-1",
    expected: "eligible",
    actual: "eligible",
    status: "correct",
    rulesetVer: "ruleset-a",
    scoringVer: "scoring-a",
  }),
  observation({
    goldenId: "golden-2",
    expected: "conditional",
    actual: "eligible",
    status: "wrong",
    rulesetVer: "ruleset-a",
    scoringVer: "scoring-a",
  }),
  observation({
    goldenId: "golden-3",
    expected: "ineligible",
    actual: null,
    status: "missing_state",
  }),
  observation({
    goldenId: "golden-4",
    expected: null,
    actual: null,
    status: "invalid_gold",
    missing: ["expected"],
  }),
  observation({
    goldenId: "golden-5",
    expected: "ineligible",
    actual: null,
    status: "missing_grant",
    missing: ["resolvedGrantId"],
  }),
];

const metrics = computeMatchingEvalMetrics(observations);
assert.equal(metrics.total, 5);
assert.equal(metrics.validGold, 4);
assert.equal(metrics.invalidGold, 1);
assert.equal(metrics.missingGrant, 1);
assert.equal(metrics.missingState, 1);
assert.equal(metrics.evaluable, 2);
assert.equal(metrics.correct, 1);
assert.equal(metrics.wrong, 1);
assert.equal(metrics.coverage, 0.5);
assert.equal(metrics.accuracy, 0.5);
assert.equal(metrics.eligibleExpected, 1);
assert.equal(metrics.eligiblePredicted, 2);
assert.equal(metrics.eligibleTruePositive, 1);
assert.equal(metrics.eligiblePrecision, 0.5);
assert.equal(metrics.eligibleRecall, 1);
assert.equal(metrics.conditionalExpected, 1);
assert.equal(metrics.conditionalPredicted, 0);
assert.equal(metrics.conditionalRecall, 0);
assert.equal(metrics.ineligibleExpected, 0);
assert.equal(metrics.gateCoveragePass, 0);
assert.equal(metrics.gateAccuracyPass, 0);
assert.equal(metrics.gateClassRecallPass, 0);
assert.equal(metrics.gatePass, 0);

const passingMetrics = computeMatchingEvalMetrics([
  observation({ goldenId: "golden-pass-1", expected: "eligible", actual: "eligible", status: "correct" }),
  observation({ goldenId: "golden-pass-2", expected: "conditional", actual: "conditional", status: "correct" }),
]);
assert.equal(passingMetrics.gateCoveragePass, 1);
assert.equal(passingMetrics.gateAccuracyPass, 1);
assert.equal(passingMetrics.gateClassRecallPass, 1);
assert.equal(passingMetrics.gatePass, 1);

const versionRefs = buildMatchingEvalVersionRefs(observations, "feedback-matching-candidates-v1");
assert.equal(versionRefs.runner, "admin_matching_eval_v1");
assert.equal(versionRefs.evalSchemaVer, "matching_eval_metrics_v1");
assert.equal(versionRefs.goldenVer, "feedback-matching-candidates-v1");
assert.equal(versionRefs.rulesetVer, "ruleset-a");
assert.equal(versionRefs.scoringVer, "scoring-a");

const mixedVersionRefs = buildMatchingEvalVersionRefs([
  observation({ goldenId: "golden-6", expected: "eligible", actual: "eligible", status: "correct", rulesetVer: "ruleset-a" }),
  observation({ goldenId: "golden-7", expected: "eligible", actual: "eligible", status: "correct", rulesetVer: "ruleset-b" }),
], "feedback-matching-candidates-v1");
assert.equal(mixedVersionRefs.rulesetVer, "mixed:2");
assert.equal(mixedVersionRefs.scoringVer, "none");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "admin_matching_eval_status_counts",
    "admin_matching_eval_coverage",
    "admin_matching_eval_accuracy",
    "admin_matching_eval_class_metrics",
    "admin_matching_eval_version_refs",
    "admin_matching_eval_gate_metrics",
  ],
  metrics,
  versionRefs,
}, null, 2));

function observation(input: Partial<MatchingEvalObservation> & Pick<MatchingEvalObservation, "goldenId" | "expected" | "actual" | "status">): MatchingEvalObservation {
  return {
    goldenId: input.goldenId,
    ref: `feedback:${input.goldenId}`,
    companyId: input.companyId ?? "00000000-0000-4000-8000-000000000001",
    grantId: input.grantId ?? "00000000-0000-4000-8000-000000000002",
    resolvedGrantId: input.resolvedGrantId ?? input.grantId ?? "00000000-0000-4000-8000-000000000002",
    expected: input.expected,
    actual: input.actual,
    status: input.status,
    rulesetVer: input.rulesetVer ?? null,
    scoringVer: input.scoringVer ?? null,
    missing: input.missing ?? [],
  };
}
