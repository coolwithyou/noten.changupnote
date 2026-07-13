import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { buildQuestionFlowSimulationReport } from "./question-flow-simulation.js";

const grants = Array.from({ length: 20 }, (_, index) => ageGrant(`age-${index}`, 20, 39));
const report = buildQuestionFlowSimulationReport({
  companies: [{
    companyId: "individual-1",
    businessKind: "individual",
    profile: {
      founder_age: 31,
      target_types: ["개인사업자"],
      list_completeness: { target_type: "complete" },
      confidence: { founder_age: 1, target_type: 1 },
    },
  }],
  grants,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  maxQuestionsPerCompany: 3,
});

assert.equal(report.operationalAccuracyEvidence, false);
assert.equal(report.companyCount, 1);
assert.equal(report.grantCount, 20);
assert.equal(report.initialConditionalCount, 20);
assert.equal(report.finalConditionalCount, 0);
assert.equal(report.resolvedInitialConditionalCount, 20);
assert.equal(report.cohortConditionalResolutionRate, 1);
assert.equal(report.eventConditionalResolutionRate, 1);
assert.equal(report.questionsAskedP50, 1);
assert.equal(report.questionsToFirstResolutionP50, 1);
assert.equal(report.companies[0]?.steps[0]?.dimension, "founder_age");
assert.equal(report.companies[0]?.steps[0]?.impact?.conditionalToEligibleCount, 20);
assert.equal(report.reachedQuestionLimitCount, 0);

assert.throws(() => buildQuestionFlowSimulationReport({
  companies: [],
  grants: [],
  maxQuestionsPerCompany: 20,
}), /1\.\.19/);

console.log("question-flow-simulation: ok");

function ageGrant(sourceId: string, min: number, max: number): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: `대표자 ${min}-${max}세 지원사업`,
      status: "open",
      apply_start: "2026-07-01",
      apply_end: "2026-07-31",
      apply_method: {},
      support_amount: { unit: "KRW", per: "기업" },
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      f_authoring_mode: "unknown",
      benefits: [],
      overall_confidence: 1,
    },
    criteria: [{
      id: `criterion:${sourceId}`,
      dimension: "founder_age",
      kind: "required",
      operator: "between",
      value: { ranges: [{ min, max }] },
      confidence: 1,
      source_span: `대표자 만 ${min}세 이상 ${max}세 이하`,
    }],
    extraction_manifest: {
      grantId: `bizinfo:${sourceId}`,
      revision: `revision:${sourceId}`,
      sourceFieldsSeen: ["criteria"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["eligibility"],
      extractorVersion: "test-reviewed-v1",
      completedAt: "2026-07-11T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
      reviewedAt: "2026-07-11T01:00:00.000Z",
    },
    raw: {
      source: "bizinfo",
      source_id: sourceId,
      payload: {},
      collected_at: "2026-07-12T00:00:00.000Z",
      status: "published",
    },
  };
}
