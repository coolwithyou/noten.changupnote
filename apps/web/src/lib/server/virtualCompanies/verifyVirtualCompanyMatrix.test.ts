import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { resolveVirtualCompanyScenario } from "./catalog";
import { verifyVirtualCompanyMatrix } from "./verifyVirtualCompanyMatrix";

const asOf = new Date("2026-08-07T00:00:00.000Z");
const scenario = resolveVirtualCompanyScenario("0000000004", { asOf });
assert.ok(scenario, "미래내일 공고용 가상기업이 필요합니다.");

const target = scenario.targets[0];
assert.ok(target);

const correctedGrant: NormalizedGrant<Record<string, unknown>> = {
  raw: {
    source: target.source,
    source_id: target.sourceId,
    payload: {},
    raw_hash: target.expectedRevision,
    collected_at: "2026-08-06T00:00:00.000Z",
    status: "published",
  },
  grant: {
    id: "352cec2b-d391-494f-842d-65eac169c0de",
    source: target.source,
    source_id: target.sourceId,
    title: "2026년 미래내일 일경험 사업 인턴형 참여기업 모집 공고",
    apply_start: "2026-08-01T00:00:00.000Z",
    apply_end: "2026-08-30T00:00:00.000Z",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
  },
  criteria: [
    {
      dimension: "insured_workforce",
      operator: "gte",
      kind: "required",
      value: { min_insured: 20 },
      confidence: 0.72,
      source_span: "고용보험 피보험자수 20인 이상",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v2",
    },
    {
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: {
        targets: ["기업", "공공기관", "지방공기업", "비영리단체", "비영리법인"],
        list_semantics: "open",
      },
      confidence: 0.65,
      source_span: "기업, 공공기관, 지방공기업, 비영리단체, 비영리법인 등",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v2",
    },
    {
      dimension: "target_type",
      operator: "not_in",
      kind: "exclusion",
      value: { targets: ["중앙행정기관"], list_semantics: "closed" },
      confidence: 0.9,
      source_span: "(중앙행정기관) 국토부, 행안부, 우체국, 세무서 등 참여불가",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v2",
    },
    {
      dimension: "target_type",
      operator: "not_in",
      kind: "exclusion",
      value: { targets: ["지방자치단체"], list_semantics: "closed" },
      confidence: 0.9,
      source_span: "(지방자치단체) 서울시, 경기도 등 참여불가",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v2",
    },
    {
      dimension: "prior_award",
      operator: "exists",
      kind: "exclusion",
      value: { scope: "self", self_kind: "same_project", channel: "general" },
      confidence: 0.88,
      source_span: "(중복참여불가) 동일 사업 내 타 운영기관 중복 참여 불가",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v2",
    },
  ],
  extraction_manifest: {
    grantId: `${target.source}:${target.sourceId}`,
    revision: target.expectedRevision,
    sourceFieldsSeen: [],
    attachmentsExpected: 1,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["required"],
    extractorVersion: target.expectedExtractorVersion,
    completedAt: "2026-08-07T00:00:00.000Z",
    reviewedAt: "2026-08-07T00:00:00.000Z",
    warnings: [],
    readiness: "reviewed",
  },
};

const pass = verifyVirtualCompanyMatrix({ grants: [correctedGrant], scenarios: [scenario], asOf });
assert.equal(pass.status, "pass");
assert.equal(pass.results[0]?.actualTier, "recommendable");
assert.equal(pass.results[0]?.visibleInUserResults, true);
assert.deepEqual(pass.results[0]?.criterionResults.insured_workforce, ["pass"]);
assert.deepEqual(pass.results[0]?.criterionResults.target_type, ["pass", "pass", "pass"]);
assert.deepEqual(pass.results[0]?.criterionResults.prior_award, ["pass"]);

const staleIndustryGrant: NormalizedGrant<Record<string, unknown>> = {
  ...correctedGrant,
  criteria: [
    ...correctedGrant.criteria,
    {
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      value: { note: "경영·사무 / 광고·마케팅 / IT 분야" },
      confidence: 0.55,
      source_span: "경영·사무 / 광고·마케팅 / IT 분야",
      needs_review: false,
      parser_version: "analysis-lab-shadow-v1",
    },
  ],
};
const regression = verifyVirtualCompanyMatrix({ grants: [staleIndustryGrant], scenarios: [scenario], asOf });
assert.equal(regression.status, "product_regression");
assert.notEqual(regression.results[0]?.actualTier, "recommendable");

console.log("verifyVirtualCompanyMatrix.test.ts: all assertions passed");
