import assert from "node:assert/strict";
import { matchGrantCriteria, updateCompanyProfileField } from "@cunote/core";
import type { CompanyProfile, Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
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

const priorAwardUpdated = updateCompanyProfileField(resolvedAgain!, {
  field: "prior_award",
  value: {
    records: [{ program: "Start-up NEST", state: "graduated", year: 2025 }],
    self_flags: { current_similar: false, same_project: false },
    has_incubation_tenancy: false,
    known_programs: ["TIPS"],
    known_program_types: ["Start-up NEST"],
  },
  confidence: 0.6,
  mode: "replace",
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: "2026-07-12T00:00:00.000Z",
});
await repositories.companies.saveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
  profile: priorAwardUpdated,
});
const priorAwardResolved = await repositories.companies.resolveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
});
assert.deepEqual(priorAwardResolved?.prior_award_history, {
  records: [{ program: "startup_nest", state: "graduated", year: 2025 }],
  self_flags: { current_similar: false, same_project: false },
  has_incubation_tenancy: false,
  known_programs: ["tips"],
  known_program_types: ["startup_nest"],
});
assert.equal(priorAwardResolved?.confidence?.prior_award, 0.6);
const priorAwardCriterion: GrantCriterion = {
  id: "runtime:prior-award",
  grant_id: "runtime-prior-award",
  dimension: "prior_award",
  operator: "in",
  kind: "exclusion",
  value: { scope: "program_type", programs: ["startup_nest"], states: ["graduated"] },
  confidence: 0.9,
  source_span: "Start-up NEST 수료기업 제외",
};
assert.equal(
  matchGrantCriteria([priorAwardCriterion], priorAwardResolved!, {
    asOf: new Date("2026-07-12T00:00:00.000Z"),
  }).eligibility,
  "ineligible",
  "저장된 구조화 수혜 이력이 실제 exclusion 재판정에 소비되어야 함",
);
const afterUnrelatedUpdate = updateCompanyProfileField(priorAwardResolved!, {
  field: "revenue",
  value: 250_000_000,
  confidence: 0.8,
});
await repositories.companies.saveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
  profile: afterUnrelatedUpdate,
});
const afterUnrelatedResolved = await repositories.companies.resolveCompanyProfile({
  companyId: demoCompanyId(),
  userId,
});
assert.deepEqual(
  afterUnrelatedResolved?.prior_award_history,
  priorAwardResolved?.prior_award_history,
  "다른 필드 저장 후에도 prior_award 구조가 silent drop되면 안 됨",
);

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

const questionSessionId = "00000000-0000-4000-8000-000000000777";
const questionEvent = await repositories.matches.saveProfileQuestionEvent({
  companyId: demoCompanyId(),
  userId,
  sessionId: questionSessionId,
  rulesetVer: "runtime-verifier",
  impact: {
    scope: "active_grant_window",
    windowLimit: 40,
    dimension: "biz_age",
    evaluatedGrantCount: 2,
    targetedConditionalCount: 1,
    dimensionResolvedGrantCount: 1,
    eligibilityResolvedCount: 1,
    conditionalToEligibleCount: 1,
    conditionalToIneligibleCount: 0,
    remainingConditionalCount: 0,
    conditionalResolutionRate: 1,
    transitionCounts: { conditional_to_eligible: 1, eligible_to_eligible: 1 },
    changedMatchStateCount: 1,
    refreshGrantIds: ["runtime:open-future"],
  },
});
assert.equal(questionEvent.sessionId, questionSessionId);
assert.equal(questionEvent.persisted, false, "runtime adapter must not claim durable telemetry");

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

const leaseStart = new Date("2026-06-26T01:00:00.000Z");
const leaseExpiresAt = new Date("2026-06-26T01:05:00.000Z");
const leaseInput = {
  provider: "popbill_guard",
  bizNo: "1234567890",
  scope: "checkBizInfo-live-attempt",
  canonicalPayload: { state: "attempt_reserved" },
  fetchedAt: leaseStart,
  expiresAt: leaseExpiresAt,
  now: leaseStart,
};
const simultaneousClaims = await Promise.all([
  repositories.enrichmentCache.claim(leaseInput),
  repositories.enrichmentCache.claim(leaseInput),
]);
assert.equal(
  simultaneousClaims.filter((entry) => entry !== null).length,
  1,
  "only one concurrent cache lease claim may succeed",
);
const activeLeaseClaim = await repositories.enrichmentCache.claim({
  ...leaseInput,
  now: new Date("2026-06-26T01:04:59.999Z"),
});
assert.equal(activeLeaseClaim, null, "an active lease must not be replaced");
const expiredLeaseClaim = await repositories.enrichmentCache.claim({
  ...leaseInput,
  fetchedAt: leaseExpiresAt,
  expiresAt: new Date("2026-06-26T01:10:00.000Z"),
  now: leaseExpiresAt,
});
assert.equal(expiredLeaseClaim?.fetchedAt.toISOString(), leaseExpiresAt.toISOString());
const permanentGuard = await repositories.enrichmentCache.claim({
  ...leaseInput,
  provider: "popbill_permanent_guard",
  expiresAt: null,
});
assert.ok(permanentGuard, "a permanent fail-closed guard should be claimable once");
const permanentGuardRetry = await repositories.enrichmentCache.claim({
  ...leaseInput,
  provider: "popbill_permanent_guard",
  fetchedAt: new Date("2036-06-26T01:00:00.000Z"),
  expiresAt: null,
  now: new Date("2036-06-26T01:00:00.000Z"),
});
assert.equal(permanentGuardRetry, null, "a permanent guard must require explicit settlement or deletion");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "runtime_profile_save",
    "runtime_profile_resolve",
    "runtime_prior_award_structured_roundtrip",
    "runtime_prior_award_match_recalculation",
    "runtime_prior_award_survives_unrelated_update",
    "runtime_profile_user_scope",
    "runtime_list_user_companies",
    "runtime_company_verify",
    "runtime_enrichment_cache_atomic_lease",
    "runtime_company_guard",
    "runtime_active_grant_filter",
    "runtime_profile_question_event_nonpersistent",
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
