import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { matchNormalizedGrant, type ServiceRepositories } from "@cunote/core";
import { attachMatchFeedbackProvenance, buildSubmitFeedbackInput } from "./matchFeedback";

const company: CompanyProfile = {
  id: "company-1",
  industries: ["인공지능"],
  confidence: { industry: 0.9 },
};
const grant: NormalizedGrant = {
  raw: {
    source: "bizinfo",
    source_id: "grant-1",
    payload: { privateRawText: "피드백에 복제되면 안 되는 원문" },
    raw_hash: "grant-revision-1",
    status: "normalized",
  },
  grant: {
    source: "bizinfo",
    source_id: "grant-1",
    title: "AI 사업화 지원",
    status: "open",
    f_regions: [],
    f_industries: ["인공지능"],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
  },
  criteria: [{
    id: "criterion-industry-1",
    dimension: "industry",
    operator: "in",
    value: { tags: ["인공지능"] },
    kind: "required",
    confidence: 1,
    source_span: "지원대상: 인공지능 분야 기업",
  }],
};
const repositories = {
  grants: {
    async findGrantById() { return grant; },
  },
  companies: {
    async resolveCompanyProfile() { return company; },
  },
  matches: {
    async calculateGrantMatch() { return matchNormalizedGrant(grant, company); },
  },
} as unknown as ServiceRepositories;
const input = buildSubmitFeedbackInput({
  companyId: "company-1",
  grantId: "bizinfo:grant-1",
  userId: "user-1",
  body: { kind: "wrong", reasonCode: "criteria_wrong" },
});
const enriched = await attachMatchFeedbackProvenance(input, repositories);
assert.equal(enriched.provenance?.captureStatus, "complete");
assert.equal(enriched.provenance?.grantRevision, "grant-revision-1");
assert.equal(enriched.provenance?.eligibility, "eligible");
assert.equal(enriched.provenance?.criterionRefs[0]?.criterionId, "criterion-industry-1");
assert.equal(enriched.provenance?.criterionRefs[0]?.sourceSpanHash?.length, 64);
assert.equal(enriched.provenance?.companyFactRefs[0]?.valueHash?.length, 64);
assert.equal(enriched.provenance?.companyFactRefs[0]?.confidence, 0.9);
const serialized = JSON.stringify(enriched.provenance);
assert.equal(serialized.includes("피드백에 복제되면 안 되는 원문"), false);
assert.equal(serialized.includes("지원대상: 인공지능 분야 기업"), false);
assert.equal(serialized.includes("인공지능"), false, "company value is represented only by hash");

const missingGrant = await attachMatchFeedbackProvenance(input, {
  grants: { async findGrantById() { return null; } },
} as unknown as ServiceRepositories);
assert.equal(missingGrant.provenance?.captureStatus, "grant_missing");
assert.equal(missingGrant.provenance?.criterionRefs.length, 0);
console.log("matchFeedbackProvenance.test.ts: all assertions passed");
