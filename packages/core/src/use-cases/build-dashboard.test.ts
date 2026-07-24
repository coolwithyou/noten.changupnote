import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { buildDashboard } from "./build-dashboard.js";

const grantId = "00000000-0000-4000-8000-000000000099";
const criterionId = "00000000-0000-4000-8000-000000000100";
const company: CompanyProfile = {};
const grants: Array<NormalizedGrant<Record<string, never>>> = [{
  grant: {
    id: grantId,
    source: "bizinfo",
    source_id: "PBLN_TEST_CONFIRMATION",
    title: "기수혜 확인 공고",
    agency_primary: "테스트기관",
    category_l1: "사업화",
    category_l2: null,
    support_amount: { unit: "KRW", per: "기업" },
    apply_start: "2026-07-01",
    apply_end: "2026-07-31",
    status: "open",
    apply_method: {},
    url: null,
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
    id: criterionId,
    grant_id: grantId,
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self", self_kind: "current_similar", channel: "general" },
    confidence: 1,
    source_span: "동일·유사 정부지원사업 수행 기업은 제외한다.",
  }],
  extraction_manifest: {
    grantId,
    revision: "test-revision",
    sourceFieldsSeen: ["criteria"],
    attachmentsExpected: 0,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["eligibility"],
    extractorVersion: "test",
    completedAt: "2026-07-25T00:00:00.000Z",
    warnings: [],
    readiness: "reviewed",
    reviewedAt: "2026-07-25T00:00:00.000Z",
  },
  raw: {
    source: "bizinfo",
    source_id: "PBLN_TEST_CONFIRMATION",
    collected_at: "2026-07-25T00:00:00.000Z",
    payload: {},
    status: "published",
  },
}];

const before = buildDashboard({ company, grants });
assert.equal(before.counts.conditional, 1);

const confirmedPass = buildDashboard({
  company,
  grants,
  confirmationsByGrantId: new Map([[
    grantId,
    [{ criterion_id: criterionId, disqualified: false }],
  ]]),
});
assert.equal(confirmedPass.counts.eligible, 1);
assert.equal(confirmedPass.matches[0]?.userConfirmedCount, 1);

const confirmedFail = buildDashboard({
  company,
  grants,
  confirmationsByGrantId: new Map([[
    grantId,
    [{ criterion_id: criterionId, disqualified: true }],
  ]]),
});
assert.equal(confirmedFail.counts.ineligible, 1);
assert.equal(confirmedFail.matches[0]?.ruleTrace[0]?.result, "fail");

console.log("build-dashboard confirmations: ok");
