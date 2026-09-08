import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisLaunchTargetIsMatchingReviewable,
  classifyAnalysisFeatureReadiness,
  normalizeAnalysisFeatureReadiness,
} from "./analysisFeatureReadiness";

for (const fixture of [
  { primaryOutcome: "publishable", matchingReadiness: "ready", applicationFieldAnalysis: "ready", expected: ["ready", "ready"] },
  { primaryOutcome: "publishable", matchingReadiness: "conditional", applicationFieldAnalysis: "held", expected: ["ready", "held"] },
  { primaryOutcome: "held", matchingReadiness: "deferred", applicationFieldAnalysis: "ready", expected: ["held", "ready"] },
  { primaryOutcome: "held", matchingReadiness: "deferred", applicationFieldAnalysis: "held", expected: ["held", "held"] },
] as const) {
  test(`feature readiness ${fixture.expected.join("/")}`, () => {
    const actual = classifyAnalysisFeatureReadiness(fixture);
    assert.equal(actual.matching.status, fixture.expected[0]);
    assert.equal(actual.authoring.status, fixture.expected[1]);
    assert.deepEqual(normalizeAnalysisFeatureReadiness(JSON.parse(JSON.stringify(actual))), actual);
  });
}

test("Kordoc을 실행하지 않은 신규 projection은 작성 ready로 추정하지 않는다", () => {
  const actual = classifyAnalysisFeatureReadiness({
    primaryOutcome: "publishable",
    matchingReadiness: "ready",
    applicationFieldAnalysis: "not_required",
  });
  assert.equal(actual.matching.status, "ready");
  assert.equal(actual.authoring.status, "held");
  assert.deepEqual(actual.authoring.reasons, ["application_field_analysis_unverified"]);
});

test("해당 작성 양식이 없는 결과도 작성 자산 ready로 오인하지 않는다", () => {
  const actual = classifyAnalysisFeatureReadiness({
    primaryOutcome: "publishable",
    matchingReadiness: "ready",
    applicationFieldAnalysis: "not_applicable",
  });
  assert.equal(actual.matching.status, "ready");
  assert.equal(actual.authoring.status, "held");
  assert.deepEqual(actual.authoring.reasons, ["application_field_analysis_not_applicable"]);
});

test("불완전하거나 모순된 projection은 fail-closed한다", () => {
  assert.throws(() => normalizeAnalysisFeatureReadiness({
    schema: "analysis-feature-readiness-v1",
    matching: { status: "ready", sourceDisposition: "ready", reasons: ["hidden_error"] },
    authoring: { status: "ready", sourceDisposition: "ready", reasons: [] },
  }), /형식/);
  assert.throws(() => normalizeAnalysisFeatureReadiness({
    schema: "analysis-feature-readiness-v1",
    matching: { status: "ready", sourceDisposition: "deferred", reasons: [] },
    authoring: { status: "ready", sourceDisposition: "held", reasons: [] },
  }), /형식/);
});

test("held target은 정규화되는 explicit matching-ready projection만 검수 대상으로 연다", () => {
  const matchingReady = classifyAnalysisFeatureReadiness({
    primaryOutcome: "publishable",
    matchingReadiness: "conditional",
    applicationFieldAnalysis: "held",
  });
  assert.equal(analysisLaunchTargetIsMatchingReviewable({
    status: "held",
    featureReadiness: matchingReady,
  }), true);
  assert.equal(analysisLaunchTargetIsMatchingReviewable({ status: "held" }), false);
  assert.equal(analysisLaunchTargetIsMatchingReviewable({
    status: "held",
    featureReadiness: {
      ...matchingReady,
      matching: { status: "ready", sourceDisposition: "deferred", reasons: [] },
    },
  }), false);
  assert.equal(analysisLaunchTargetIsMatchingReviewable({
    status: "failed",
    featureReadiness: matchingReady,
  }), false);
});
