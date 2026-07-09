import assert from "node:assert/strict";
import { updateCompanyProfileField } from "@cunote/core";
import type { CompanyProfile, Grant, NormalizedGrant } from "@cunote/contracts";
import { createRuntimeRepositories, demoCompanyId } from "./runtime";

const userId = "00000000-0000-4000-8000-000000000001";
const baseProfile: CompanyProfile = {
  name: "검증 기업",
  region: { code: "41", label: "경기" },
  biz_age_months: 26,
  industries: ["ICT"],
  confidence: {
    region: 0.7,
    biz_age: 0.6,
  },
};

const activeGrantFixtures = [
  normalizedGrant("open-future", "open", "2026-07-01"),
  normalizedGrant("closed-status", "closed", "2026-07-01"),
  normalizedGrant("stale-open", "open", "2026-06-01"),
  normalizedGrant("unknown-no-end", "unknown", null),
];

const repositories = createRuntimeRepositories({
  async loadGrants() {
    return activeGrantFixtures;
  },
  async loadCompanyProfile() {
    return baseProfile;
  },
});

const current = await repositories.companies.resolveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
});
assert.ok(current, "demo company profile should resolve");
assert.equal(current.biz_age_months, 26);

const updated = updateCompanyProfileField(current, {
  field: "biz_age",
  value: 42,
  confidence: 0.92,
});
const saved = await repositories.companies.saveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
  profile: updated,
});
assert.equal(saved.biz_age_months, 42);
assert.equal(saved.confidence?.biz_age, 0.92);

const resolvedAgain = await repositories.companies.resolveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
});
assert.equal(resolvedAgain?.biz_age_months, 42);
assert.equal(resolvedAgain?.confidence?.biz_age, 0.92);

const otherUserProfile = await repositories.companies.resolveCompanyProfile({
  companyId: demoCompanyId(),
  userId: "00000000-0000-4000-8000-000000000002",
});
assert.equal(otherUserProfile?.biz_age_months, 26);
assert.equal(otherUserProfile?.confidence?.biz_age, 0.6);

const companies = await repositories.companies.listUserCompanies(userId);
assert.equal(companies[0]?.profile.biz_age_months, 42);
assert.equal(companies[0]?.profile.confidence?.biz_age, 0.92);

const verification = await repositories.companies.verifyCompany({
  companyId: demoCompanyId(),
  userId,
  bizNo: "1234567890",
  ownerName: "검증 대표",
  openedOn: "2024-01-01",
});
assert.equal(verification.companyId, demoCompanyId());
assert.equal(verification.bizNo, "1234567890");
assert.equal(verification.verified, true);
assert.equal(verification.verifyMethod, "dev_self_declared");
assert.match(verification.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
const verifiedCompanies = await repositories.companies.listUserCompanies(userId);
assert.equal(verifiedCompanies[0]?.verified, true);
assert.equal(verifiedCompanies[0]?.bizNoMasked, "123-**-67***");

const outsideCompany = await repositories.companies.resolveCompanyProfile({
  companyId: "00000000-0000-4000-8000-000000000999",
  userId,
});
assert.equal(outsideCompany, null);

const activeGrants = await repositories.grants.listActiveGrants({
  asOf: new Date("2026-06-27T12:00:00.000Z"),
  limit: 10,
});
assert.deepEqual(
  activeGrants.map((entry) => entry.grant.source_id),
  ["open-future", "unknown-no-end"],
);

const fetchedAt = new Date("2026-06-26T00:00:00.000Z");
const expiresAt = new Date("2026-06-27T00:00:00.000Z");
await repositories.enrichmentCache.put({
  provider: "popbill",
  bizNo: "1234567890",
  scope: "checkBizInfo",
  canonicalPayload: {
    profile: { biz_age_months: 42 },
    facts: { maskedBizNo: "123-**-67***" },
  },
  providerResultCode: "100",
  providerResultMessage: "정상",
  fetchedAt,
  expiresAt,
  payloadHash: "verify-hash",
});
const freshCache = await repositories.enrichmentCache.getFresh({
  provider: "popbill",
  bizNo: "1234567890",
  scope: "checkBizInfo",
  now: new Date("2026-06-26T12:00:00.000Z"),
});
assert.equal(freshCache?.providerResultCode, "100");
assert.deepEqual(freshCache?.canonicalPayload?.profile, { biz_age_months: 42 });

const expiredCache = await repositories.enrichmentCache.getFresh({
  provider: "popbill",
  bizNo: "1234567890",
  scope: "checkBizInfo",
  now: new Date("2026-06-27T00:00:00.000Z"),
});
assert.equal(expiredCache, null);

await repositories.enrichmentCache.put({
  provider: "popbill",
  bizNo: "7465400870",
  scope: "checkBizInfo",
  canonicalPayload: {
    profile: { name: "영구 캐시 기업" },
    facts: { maskedBizNo: "746-**-00***" },
  },
  providerResultCode: "100",
  providerResultMessage: "정상",
  fetchedAt,
  expiresAt: null,
  payloadHash: "verify-permanent-hash",
});
const permanentCache = await repositories.enrichmentCache.getFresh({
  provider: "popbill",
  bizNo: "7465400870",
  scope: "checkBizInfo",
  now: new Date("2036-06-27T00:00:00.000Z"),
});
assert.equal(permanentCache?.providerResultCode, "100");
assert.equal(permanentCache?.expiresAt, null);
assert.deepEqual(permanentCache?.canonicalPayload?.profile, { name: "영구 캐시 기업" });

console.log(JSON.stringify({
  ok: true,
  checked: [
    "runtime_profile_save",
    "runtime_profile_resolve",
    "runtime_profile_user_scope",
    "runtime_list_user_companies",
    "runtime_company_verify",
    "runtime_company_guard",
    "runtime_active_grant_filter",
    "runtime_enrichment_cache_fresh",
    "runtime_enrichment_cache_expired",
    "runtime_enrichment_cache_permanent",
  ],
  companyId: demoCompanyId(),
  bizAgeMonths: resolvedAgain?.biz_age_months,
}, null, 2));

function normalizedGrant(
  sourceId: string,
  status: Grant["status"],
  applyEnd: string | null,
): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: {
      source: "kstartup",
      source_id: sourceId,
      payload: { sourceId },
      status: "normalized",
    },
    grant: {
      source: "kstartup",
      source_id: sourceId,
      title: sourceId,
      status,
      apply_end: applyEnd,
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.9,
    },
    criteria: [],
  };
}
