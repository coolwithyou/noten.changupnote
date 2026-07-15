import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import {
  GRANT_ANALYSIS_EVALUATION_AXES,
  GRANT_ANALYSIS_EVALUATION_RESERVED_AXES,
  buildGrantAnalysisEvaluationConsensus,
  grantAnalysisEvaluationQualityDenominator,
  isGrantAnalysisEvaluationReservedAxis,
  semanticGrantAnalysisJudgmentSha256,
  validateGrantAnalysisEvaluationJudgeLedger,
  type GrantAnalysisEvaluationAxisJudgment,
  type GrantAnalysisEvaluationJudgeId,
  type GrantAnalysisEvaluationJudgeLedger,
  type GrantAnalysisEvaluationState,
} from "./grant-analysis-evaluation.js";

assert.equal(GRANT_ANALYSIS_EVALUATION_AXES.length, 22);
assert.deepEqual(GRANT_ANALYSIS_EVALUATION_AXES, CRITERION_DIMENSIONS);
assert.deepEqual(GRANT_ANALYSIS_EVALUATION_RESERVED_AXES, ["premises", "export_performance"]);
assert.equal(isGrantAnalysisEvaluationReservedAxis("premises"), true);
assert.equal(isGrantAnalysisEvaluationReservedAxis("region"), false);

const judge1 = ledger("judge_1", {
  region: judgment("region", "condition_present", { regions: ["11"] }),
  industry: judgment("industry", "unknown"),
  biz_age: judgment("biz_age", "explicit_no_condition"),
});
const judge2 = ledger("judge_2", {
  region: {
    ...judgment("region", "condition_present", { regions: ["11"] }),
    confidence: 0.71,
    evidence: [{ artifactId: "api", locatorKind: "paragraph", locator: "p2", quote: "서울 소재" }],
  },
  industry: judgment("industry", "condition_present", { tags: ["AI"] }),
  biz_age: judgment("biz_age", "explicit_no_condition"),
});

const pending = buildGrantAnalysisEvaluationConsensus({ judge1, judge2 });
assert.deepEqual(pending.disagreementAxes, ["industry"]);
assert.deepEqual(pending.judge3EligibleAxes, ["industry"]);
assert.equal(pending.axes.find((axis) => axis.dimension === "region")?.resolution, "judge_1_2_agreement");
assert.equal(pending.axes.find((axis) => axis.dimension === "industry")?.state, "unresolved");

const adjudicated = buildGrantAnalysisEvaluationConsensus({
  judge1,
  judge2,
  judge3: partialJudge3([
    judgment("industry", "unresolved"),
  ]),
});
assert.equal(adjudicated.axes.find((axis) => axis.dimension === "industry")?.state, "unresolved");
assert.equal(adjudicated.axes.find((axis) => axis.dimension === "industry")?.resolution, "unresolved");

const resolved = buildGrantAnalysisEvaluationConsensus({
  judge1,
  judge2,
  judge3: partialJudge3([
    judgment("industry", "condition_present", { tags: ["AI"] }),
  ]),
});
assert.equal(resolved.axes.find((axis) => axis.dimension === "industry")?.state, "condition_present");
assert.equal(resolved.axes.find((axis) => axis.dimension === "industry")?.resolution, "judge_3");
assert.equal(resolved.axes.find((axis) => axis.dimension === "premises")?.inspectable, false);
assert.equal(resolved.axes.find((axis) => axis.dimension === "premises")?.includedInQualityDenominator, false);
assert.deepEqual(grantAnalysisEvaluationQualityDenominator(resolved), {
  totalAxes: 22,
  inspectableAxes: 20,
  reservedAxes: 2,
  confirmedInspectableAxes: 20,
  unresolvedInspectableAxes: 0,
});

assert.throws(
  () => buildGrantAnalysisEvaluationConsensus({
    judge1,
    judge2,
    judge3: partialJudge3([judgment("region", "condition_present", { regions: ["11"] })]),
  }),
  /not eligible for agreed axis region/,
);
assert.throws(
  () => validateGrantAnalysisEvaluationJudgeLedger({ ...judge1, axes: judge1.axes.slice(1) }),
  /all 22 axes exactly once/,
);
assert.throws(
  () => validateGrantAnalysisEvaluationJudgeLedger({
    ...judge1,
    axes: [...judge1.axes, judge1.axes[0]!],
  }),
  /Duplicate evaluation axis/,
);
assert.throws(
  () => buildGrantAnalysisEvaluationConsensus({
    judge1,
    judge2,
    judge3: partialJudge3([judgment("industry", "condition_present")]),
  }),
  /condition_present requires normalizedCondition/,
);
assert.throws(
  () => buildGrantAnalysisEvaluationConsensus({
    judge1,
    judge2,
    judge3: partialJudge3([judgment("industry", "explicit_no_condition", { tags: ["AI"] })]),
  }),
  /explicit_no_condition cannot carry normalizedCondition/,
);
assert.throws(
  () => buildGrantAnalysisEvaluationConsensus({
    judge1,
    judge2,
    judge3: partialJudge3([judgment("industry", "invalid_state" as GrantAnalysisEvaluationState)]),
  }),
  /Invalid Judge 3 state for industry/,
);

assert.equal(
  semanticGrantAnalysisJudgmentSha256(judge1.axes[0]!),
  semanticGrantAnalysisJudgmentSha256({ ...judge1.axes[0]!, confidence: 0.01, note: "다른 메모" }),
  "confidence, note, and evidence are not semantic agreement fields",
);
assert.equal(
  semanticGrantAnalysisJudgmentSha256({ ...judge1.axes[0]!, exceptions: ["ＡＩ  분야"] }),
  semanticGrantAnalysisJudgmentSha256({ ...judge1.axes[0]!, exceptions: ["AI 분야"] }),
  "semantic text normalization uses NFKC consistently with evidence grounding",
);

console.log("grant-analysis-evaluation.test.ts: all assertions passed");

function ledger(
  judgeId: GrantAnalysisEvaluationJudgeId,
  overrides: Partial<Record<CriterionDimension, GrantAnalysisEvaluationAxisJudgment>> = {},
): GrantAnalysisEvaluationJudgeLedger {
  return {
    recordType: "grant_analysis_evaluation_judge_ledger",
    schemaVersion: 1,
    judgeId,
    grantKey: "synthetic:grant-1",
    sourceRevision: "sha256:source-1",
    truncated: false,
    schemaRecovered: false,
    axes: CRITERION_DIMENSIONS.map((dimension) =>
      overrides[dimension] ?? judgment(dimension, "explicit_no_condition")),
  };
}

function partialJudge3(
  axes: GrantAnalysisEvaluationAxisJudgment[],
): GrantAnalysisEvaluationJudgeLedger {
  return {
    recordType: "grant_analysis_evaluation_judge_ledger",
    schemaVersion: 1,
    judgeId: "judge_3",
    grantKey: "synthetic:grant-1",
    sourceRevision: "sha256:source-1",
    truncated: false,
    schemaRecovered: false,
    axes,
  };
}

function judgment(
  dimension: CriterionDimension,
  state: GrantAnalysisEvaluationState,
  normalizedCondition: unknown | null = null,
): GrantAnalysisEvaluationAxisJudgment {
  return {
    dimension,
    state,
    normalizedCondition,
    evidence: state === "condition_present"
      ? [{ artifactId: "api", locatorKind: "paragraph", locator: "p1", quote: "서울 소재" }]
      : [],
    confidence: 0.9,
    exceptions: [],
    logicalRelation: state === "condition_present" ? "and" : "not_applicable",
    applicablePeriod: null,
    note: "",
  };
}
