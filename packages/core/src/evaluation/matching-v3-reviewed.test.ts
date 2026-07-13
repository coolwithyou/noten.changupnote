import assert from "node:assert/strict";
import type { Eligibility } from "@cunote/contracts";
import { evaluateMatchingV3ReviewedFixture } from "./matching-v3-reviewed.js";
import type {
  V3CompanyAnnotation,
  V3EligibilityPairAnnotation,
  V3GrantAnnotation,
  V3LabelStatus,
} from "./v3-annotations.js";

const AS_OF = new Date("2026-07-13T00:00:00.000Z");
const REVIEW_METADATA = {
  annotatorId: "annotator@example.com",
  annotatedAt: "2026-07-11T00:00:00.000Z",
  reviewerId: "reviewer@example.com",
  reviewedAt: "2026-07-12T00:00:00.000Z",
} as const;
const GRANT = grant();

const metricCompanies = [
  company("eligible-correct", "11"),
  company("eligible-false-positive", "11"),
  company("eligible-preserved-as-conditional", null),
  company("ineligible-correct", "26"),
  company("eligible-false-ineligible", "26"),
];
const metricPairs = [
  pair("eligible-correct", "eligible"),
  pair("eligible-false-positive", "conditional"),
  pair("eligible-preserved-as-conditional", "eligible"),
  pair("ineligible-correct", "ineligible"),
  pair("eligible-false-ineligible", "eligible"),
];
const metricReport = evaluateMatchingV3ReviewedFixture({
  companies: metricCompanies,
  grants: [GRANT],
  pairs: metricPairs,
  asOf: AS_OF,
});

assert.deepEqual(metricReport.metrics.eligible_precision, { numerator: 1, denominator: 2, value: 0.5 });
assert.deepEqual(metricReport.metrics.eligible_recall, { numerator: 2, denominator: 3, value: 0.6667 });
assert.deepEqual(metricReport.metrics.ineligible_precision, { numerator: 1, denominator: 2, value: 0.5 });
assert.equal(metricReport.confusionMatrix.eligible.eligible, 1);
assert.equal(metricReport.confusionMatrix.eligible.conditional, 1);
assert.equal(metricReport.confusionMatrix.eligible.ineligible, 1);
assert.equal(metricReport.confusionMatrix.conditional.eligible, 1);
assert.equal(metricReport.confusionMatrix.ineligible.ineligible, 1);
assert.equal(metricReport.operationalReady, false);
assert.equal(metricReport.status, "not_ready");

const passingCompanies: V3CompanyAnnotation[] = [];
const passingPairs: V3EligibilityPairAnnotation[] = [];
appendCases(9, "eligible-true", "11", "eligible");
appendCases(1, "eligible-false", "11", "conditional");
appendCases(1, "eligible-preserved", null, "eligible");
appendCases(97, "ineligible-true", "26", "ineligible");
appendCases(3, "ineligible-false", "26", "conditional");
const passingReport = evaluateMatchingV3ReviewedFixture({
  companies: passingCompanies,
  grants: [GRANT],
  pairs: passingPairs,
  asOf: AS_OF,
  minimumReviewedPairs: passingPairs.length,
});

assert.deepEqual(passingReport.metrics.eligible_precision, { numerator: 9, denominator: 10, value: 0.9 });
assert.deepEqual(passingReport.metrics.eligible_recall, { numerator: 10, denominator: 10, value: 1 });
assert.deepEqual(passingReport.metrics.ineligible_precision, { numerator: 97, denominator: 100, value: 0.97 });
assert.deepEqual(passingReport.mvpThresholds, {
  eligible_precision: { minimum: 0.9, pass: true },
  eligible_recall: { minimum: 0.95, pass: true },
  ineligible_precision: { minimum: 0.97, pass: true },
});
assert.equal(passingReport.operationalReady, true, "threshold equality must pass the MVP gate");
assert.equal(passingReport.status, "ready");
assert.equal(passingReport.notReadyReasons.length, 0);

const insufficientSampleReport = evaluateMatchingV3ReviewedFixture({
  companies: passingCompanies,
  grants: [GRANT],
  pairs: passingPairs,
  asOf: AS_OF,
});
assert.deepEqual(insufficientSampleReport.sampleGate, {
  requiredReviewedPairs: 500,
  actualReviewedPairs: 111,
  pass: false,
});
assert.equal(insufficientSampleReport.gates.sampleSize, false);
assert.equal(insufficientSampleReport.operationalReady, false);
assert.ok(insufficientSampleReport.notReadyReasons.includes("insufficient_reviewed_pairs"));

const zeroReviewedReport = evaluateMatchingV3ReviewedFixture({
  companies: [{ ...company("draft-company", "11"), labelStatus: "draft" }],
  grants: [{ ...GRANT, labelStatus: "draft" }],
  pairs: [{ ...pair("draft-company", "eligible"), labelStatus: "draft" }],
  asOf: AS_OF,
});
assert.equal(zeroReviewedReport.reviewedPairCount, 0);
assert.equal(zeroReviewedReport.evaluatedPairCount, 0);
assert.equal(zeroReviewedReport.excludedDraftPairCount, 1);
assert.equal(zeroReviewedReport.metrics.eligible_precision.value, null);
assert.equal(zeroReviewedReport.metrics.eligible_recall.value, null);
assert.equal(zeroReviewedReport.metrics.ineligible_precision.value, null);
assert.equal(zeroReviewedReport.operationalReady, false);
assert.equal(zeroReviewedReport.status, "not_ready");
assert.ok(zeroReviewedReport.notReadyReasons.includes("no_reviewed_pairs"));

const invalidDependencyReport = evaluateMatchingV3ReviewedFixture({
  companies: [company("missing-grant-company", "11")],
  grants: [{ ...GRANT, labelStatus: "draft" }],
  pairs: [pair("missing-grant-company", "eligible")],
  asOf: AS_OF,
});
assert.equal(invalidDependencyReport.reviewedPairCount, 1);
assert.equal(invalidDependencyReport.evaluatedPairCount, 0);
assert.equal(invalidDependencyReport.invalidReviewedPairCount, 1);
assert.equal(invalidDependencyReport.gates.reviewedFixture, false);
assert.equal(invalidDependencyReport.operationalReady, false);

assert.throws(() => evaluateMatchingV3ReviewedFixture({
  companies: [company("duplicate", "11"), company("duplicate", "26")],
  grants: [GRANT],
  pairs: [],
  asOf: AS_OF,
}), /duplicate companyId/);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "current_matcher_re_evaluation",
    "eligible_precision",
    "eligible_preservation_recall",
    "ineligible_precision",
    "inclusive_mvp_thresholds",
    "minimum_500_reviewed_pair_gate",
    "reviewed_only_gate",
    "zero_reviewed_not_ready",
    "reviewed_dependency_integrity",
  ],
}, null, 2));

function appendCases(count: number, prefix: string, regionCode: string | null, expected: Eligibility): void {
  for (let index = 0; index < count; index += 1) {
    const companyId = `${prefix}-${index + 1}`;
    passingCompanies.push(company(companyId, regionCode));
    passingPairs.push(pair(companyId, expected));
  }
}

function company(
  companyId: string,
  regionCode: string | null,
  labelStatus: V3LabelStatus = "reviewed",
): V3CompanyAnnotation {
  return {
    recordType: "company",
    schemaVersion: "matching-v3",
    labelStatus,
    companyId,
    businessKind: "corporation",
    profile: regionCode ? { region: { code: regionCode } } : {},
    sourceFixture: "synthetic:test",
    ...REVIEW_METADATA,
  };
}

function grant(labelStatus: V3LabelStatus = "reviewed"): V3GrantAnnotation {
  return {
    recordType: "grant",
    schemaVersion: "matching-v3",
    labelStatus,
    grantId: "bizinfo:g1",
    source: "bizinfo",
    sourceId: "g1",
    title: "서울 소재 기업 지원",
    audience: "company",
    sourceFixture: "archive:g1:r1",
    sourceRevision: "r1",
    criteria: [{
      criterionId: "bizinfo:g1:region",
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["11"] },
      sourceSpan: "서울 소재 기업",
      sourceField: "target",
      annotationConfidence: 1,
      note: null,
    }],
    ...REVIEW_METADATA,
  };
}

function pair(
  companyId: string,
  expectedEligibility: Eligibility,
  labelStatus: V3LabelStatus = "reviewed",
): V3EligibilityPairAnnotation {
  return {
    recordType: "eligibility_pair",
    schemaVersion: "matching-v3",
    labelStatus,
    pairId: `bizinfo:g1::${companyId}`,
    grantId: "bizinfo:g1",
    companyId,
    expectedEligibility,
    split: "development",
    hardFailCriterionIds: expectedEligibility === "ineligible" ? ["bizinfo:g1:region"] : [],
    unknownCriterionIds: expectedEligibility === "conditional" ? ["bizinfo:g1:region"] : [],
    resolvableByProfileInput: expectedEligibility === "conditional" ? true : null,
    note: "independently reviewed fixture",
    ...REVIEW_METADATA,
  };
}
