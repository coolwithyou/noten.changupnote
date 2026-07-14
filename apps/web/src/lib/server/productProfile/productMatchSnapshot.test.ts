import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { buildProductTeaserSnapshot } from "./productMatchSnapshot";
import { normalizeProductProfileAnswers } from "./normalizeProductProfileAnswers";
import {
  resolveProductCompanyProfile,
  type ProductProfileResolverDependencies,
} from "./resolveProductCompanyProfile";

const asOf = "2026-07-14T14:00:00.000Z";
const dependencies: ProductProfileResolverDependencies = {
  companies: {
    async listUserCompanies() { throw new Error("anonymous path read companies"); },
    async resolveCompanyProfile() { throw new Error("anonymous path resolved a company"); },
    async saveCompanyProfile() { throw new Error("anonymous path saved a company"); },
  },
  enrichmentCache: {
    async getFresh() { throw new Error("request-only answer should not read cache without bizNo"); },
  },
  consents: {
    async listCompanyConsents() { throw new Error("anonymous path read consents"); },
  },
};

const initialProfile = normalizeProductProfileAnswers({
  asOf,
  answers: [{ field: "region", value: { code: "11", label: "서울" } }],
});
const initialResolution = await resolveProductCompanyProfile({
  context: "anonymous_teaser",
  ephemeralProfile: initialProfile,
  asOf,
}, dependencies);
const initial = buildProductTeaserSnapshot({
  resolution: initialResolution,
  grants: [revenueGrant()],
  asOf: new Date(asOf),
});
assert.equal(initial.counts.conditional, 1);
assert.equal(initial.nextQuestion?.dimension, "revenue");
assert.equal(initial.profileView.rows.length, 19);
assert.equal(initial.profileView.rows.find((row) => row.dimension === "revenue")?.status, "unknown");

const answeredProfile = normalizeProductProfileAnswers({
  asOf,
  answers: [
    { field: "region", value: { code: "11", label: "서울" } },
    { field: "revenue", value: 900_000_000 },
  ],
});
const answeredResolution = await resolveProductCompanyProfile({
  context: "anonymous_teaser",
  ephemeralProfile: answeredProfile,
  asOf,
}, dependencies);
const answered = buildProductTeaserSnapshot({
  resolution: answeredResolution,
  grants: [revenueGrant()],
  asOf: new Date(asOf),
});
assert.equal(answered.counts.eligible, 1);
assert.equal(answered.counts.conditional, 0);
assert.equal(answered.matches[0]?.eligibility, "eligible");
assert.equal(answered.profileView.rows.find((row) => row.dimension === "revenue")?.status, "known");
assert.equal(answered.nextQuestion, null);
assert.equal(answered.searchContext?.asOf, asOf);
assert.equal(answered.profileView.asOf, asOf);
assert.equal(Object.hasOwn(answered, "profile"), false, "product response must not serialize raw CompanyProfile");

console.log("productProfile/productMatchSnapshot.test.ts: all assertions passed");

function revenueGrant(): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: "R3_REVENUE",
      title: "연 매출 10억원 이하 지원",
      agency_primary: "테스트기관",
      category_l1: "사업화",
      category_l2: null,
      support_amount: { unit: "KRW", per: "기업", max: 100_000_000 },
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
      id: "revenue-max",
      dimension: "revenue",
      kind: "required",
      operator: "lte",
      value: { max_krw: 1_000_000_000 },
      confidence: 1,
      source_span: "최근 연 매출 10억원 이하",
    }],
    extraction_manifest: {
      grantId: "bizinfo:R3_REVENUE",
      revision: "revision:R3_REVENUE",
      sourceFieldsSeen: ["title", "criteria"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["eligibility"],
      extractorVersion: "test-reviewed-v1",
      completedAt: "2026-07-14T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
      reviewedAt: "2026-07-14T01:00:00.000Z",
    },
    raw: {
      source: "bizinfo",
      source_id: "R3_REVENUE",
      collected_at: "2026-07-14T00:00:00.000Z",
      payload: {},
      status: "published",
    },
  };
}
