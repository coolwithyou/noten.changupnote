import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import {
  buildBusinessNumberFirstResultReport,
  projectBusinessNumberInitialProfile,
} from "./business-number-first-results.js";

const fullProfile: CompanyProfile = {
  id: "company-1",
  region: { code: "11", label: "서울" },
  biz_age_months: 24,
  industries: ["소프트웨어"],
  industry_codes: ["62010"],
  size: "소기업",
  revenue_krw: 80_000_000,
  employees_count: 3,
  founder_age: 32,
  target_types: ["법인사업자", "창업기업"],
  business_status: { active: true, label: "계속사업자" },
  confidence: { region: 1, biz_age: 1, industry: 1, size: 1, revenue: 1, employees: 1, founder_age: 1 },
};
const projected = projectBusinessNumberInitialProfile(fullProfile, "corporation");
assert.equal(projected.region?.code, "11");
assert.equal(projected.biz_age_months, 24);
assert.equal(projected.revenue_krw, undefined);
assert.equal(projected.employees_count, undefined);
assert.equal(projected.founder_age, undefined);
assert.deepEqual(projected.target_types, ["법인사업자"]);
assert.equal(projected.list_completeness?.industry, "partial");
assert.equal(projected.list_completeness?.target_type, "partial");

const report = buildBusinessNumberFirstResultReport({
  companies: [{ companyId: "company-1", businessKind: "corporation", profile: fullProfile }],
  grants: [
    grant("region", criterion("region", "in", { regions: ["11"] }, "서울 소재 기업")),
    grant("revenue", criterion("revenue", "lte", { max_krw: 100_000_000 }, "매출 1억원 이하")),
    grant("region-fail", criterion("region", "in", { regions: ["26"] }, "부산 소재 기업")),
  ],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.deepEqual(report.initialEligibilityCounts, { eligible: 1, conditional: 1, ineligible: 1 });
assert.deepEqual(report.fullEligibilityCounts, { eligible: 2, conditional: 0, ineligible: 1 });
assert.equal(report.immediateDeterminateRate, 0.6667);
assert.equal(report.initialRecommendableRate, 0.3333);
assert.equal(report.falseIneligibleAgainstFullCount, 0);
assert.equal(report.unsafeIneligibleAgainstFullViableCount, 0);
assert.deepEqual(report.recommendableByExtractionReadiness, {
  reviewed: 1,
  structured_unreviewed: 0,
  partial: 0,
  unstructured: 0,
});
assert.equal(report.companies[0]?.firstQuestionDimension, "revenue");
assert.equal(report.companies[0]?.firstQuestionAffectedGrantCount, 1);
assert.equal(report.companies[0]?.firstQuestionResolvesGrantCount, 1);
assert.equal(report.autofillCoverage.authoritative_axis_coverage.numerator, 3);
assert.equal(report.autofillCoverage.total_answered_coverage.numerator, 4);

console.log("business-number-first-results: ok");

function criterion(
  dimension: GrantCriterion["dimension"],
  operator: GrantCriterion["operator"],
  value: Record<string, unknown>,
  sourceSpan: string,
): GrantCriterion {
  return { dimension, operator, value, kind: "required", confidence: 1, source_field: "target", source_span: sourceSpan };
}
function grant(sourceId: string, criterionValue: GrantCriterion): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: { source: "bizinfo", source_id: sourceId, payload: {}, status: "normalized" },
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [criterionValue],
    extraction_manifest: {
      grantId: `bizinfo:${sourceId}`,
      revision: "r1",
      sourceFieldsSeen: ["target"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["required"],
      extractorVersion: "test",
      completedAt: "2026-07-01T00:00:00.000Z",
      reviewedAt: "2026-07-01T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
    },
  };
}
