import assert from "node:assert/strict";
import type { CompanyProfile, ConsentRecordDto } from "@cunote/contracts";
import type { CompanyRecord, EnrichmentCacheEntry } from "@cunote/core";
import {
  PRODUCT_PROFILE_SOURCE_POLICIES,
  ProductProfileResolutionError,
  resolveProductCompanyProfile,
  resolveSystemProductCompanyProfile,
  type ProductProfileResolverDependencies,
} from "./resolveProductCompanyProfile";

const asOf = "2026-07-14T12:00:00.000Z";
const ownerUserId = "user-owner";
const companyId = "company-owner";
const publicCacheProfile: CompanyProfile = {
  name: "응답에 노출되면 안 되는 상호",
  region: { code: "11", label: "서울특별시" },
  business_status: { active: true, label: "계속사업자" },
  other_conditions: {
    raw_payload: { access_token: "raw-secret-token" },
    representative_name: "홍길동",
  },
  confidence: { region: 0.9, business_status: 0.95 },
  profile_evidence: {
    region: observation("popbill", "shared", 0.9),
    business_status: observation("popbill", "shared", 0.95),
  },
};
const ownedProfile: CompanyProfile = {
  size: "중소",
  employees_count: 8,
  revenue_krw: 1_200_000_000,
  founder_age: 41,
  other_conditions: {
    raw_payload: { birth_date: "19850101", phone: "01012345678" },
  },
  confidence: { employees: 0.6, revenue: 0.9, founder_age: 0.9 },
  profile_evidence: {
    employees: {
      ...observation("cunote_profile_question", "user", 0.6),
      sourceKind: "self_declared",
      persistenceClass: "portable_user_answer",
    },
    revenue: observation("popbill", "user", 0.9),
    founder_age: {
      ...observation("codef", "user", 0.9),
      sourceKind: "auth_supplied",
    },
  },
};

const ownerCompany: CompanyRecord = {
  id: companyId,
  name: "테스트 회사",
  profile: ownedProfile,
  role: "owner",
};

let activeConsents: ConsentRecordDto[] = [];
let cacheReads = 0;
let companyLists = 0;
let companyResolutions = 0;
let refreshCalls = 0;
let saves = 0;
let exposePublicCache = true;

const dependencies: ProductProfileResolverDependencies = {
  companies: {
    async listUserCompanies(userId) {
      companyLists += 1;
      return userId === ownerUserId ? [ownerCompany] : [];
    },
    async resolveCompanyProfile(input) {
      companyResolutions += 1;
      return input.companyId === companyId ? ownedProfile : null;
    },
    async saveCompanyProfile(input) {
      saves += 1;
      return input.profile;
    },
  },
  enrichmentCache: {
    async getFresh(input) {
      cacheReads += 1;
      if (!exposePublicCache || input.provider !== "popbill" || input.scope !== "checkBizInfo") return null;
      return cacheEntry(publicCacheProfile);
    },
  },
  consents: {
    async listCompanyConsents(requestedCompanyId, userId) {
      assert.equal(requestedCompanyId, companyId);
      assert.equal(userId, ownerUserId);
      return activeConsents;
    },
  },
  async refreshOwnedSource(input) {
    refreshCalls += 1;
    assert.equal(input.source, "popbill_refresh");
    return {
      business_status: { active: true, label: "계속사업자" },
      profile_evidence: {
        business_status: observation("popbill", "user", 0.95),
      },
    };
  },
};

await assert.rejects(
  () => resolveProductCompanyProfile({ context: "anonymous_teaser", asOf }, dependencies),
  (error: unknown) => error instanceof ProductProfileResolutionError &&
    error.code === "biz_no_required" && error.status === 400,
);
assert.equal(cacheReads, 0, "empty anonymous input must fail before reading any cache");
assert.equal(companyLists, 0, "anonymous resolution must never enumerate owner companies");
assert.equal(companyResolutions, 0, "anonymous resolution must never read company profile rows");

const anonymous = await resolveProductCompanyProfile({
  context: "anonymous_teaser",
  bizNo: "746-54-00870",
  asOf,
}, dependencies);
assert.equal(anonymous.profile.region?.code, "11");
assert.equal(anonymous.profile.name, "응답에 노출되면 안 되는 상호", "internal save materialization keeps safe company identity");
assert.equal(anonymous.profile.other_conditions, undefined);
assert.equal(anonymous.view.rows.length, 19);
assert.equal(anonymous.view.rows.find((row) => row.dimension === "region")?.status, "known");
assert.equal(anonymous.sourceReceipts.find((receipt) => receipt.source === "popbill_cache")?.state, "consumed");
assert.equal(companyLists, 0, "anonymous cache resolution must not touch owner access paths");
const anonymousJson = JSON.stringify(anonymous.view);
for (const forbidden of ["응답에 노출되면 안 되는 상호", "raw-secret-token", "representative_name", "access_token", "홍길동"]) {
  assert.equal(anonymousJson.includes(forbidden), false, `safe view leaked ${forbidden}`);
}
assert.deepEqual(
  await resolveProductCompanyProfile({ context: "anonymous_teaser", bizNo: "7465400870", asOf }, dependencies),
  anonymous,
  "the same cache materialization and asOf must replay deterministically",
);
exposePublicCache = false;
await assert.rejects(
  () => resolveProductCompanyProfile({ context: "anonymous_teaser", bizNo: "7465400870", asOf }, dependencies),
  (error: unknown) => error instanceof ProductProfileResolutionError &&
    error.code === "product_profile_unavailable" && error.status === 503,
  "passive anonymous teaser must remain cache-only on a real cache miss",
);
exposePublicCache = true;
assert.equal(refreshCalls, 0, "anonymous cache miss/hit must never invoke live refresh");

activeConsents = [];
const revokedOwner = await resolveProductCompanyProfile({
  context: "owned_read",
  companyId,
  userId: ownerUserId,
  asOf,
}, dependencies);
assert.equal(revokedOwner.profile.employees_count, 8, "same-user portable answer remains visible");
assert.equal(revokedOwner.profile.size, "중소", "legacy persisted user fields pass through the single compatibility adapter");
assert.equal(revokedOwner.profile.id, companyId);
assert.equal(revokedOwner.profile.name, "테스트 회사");
assert.equal(revokedOwner.profile.revenue_krw, undefined, "revoked basic_info observation must be excluded");
assert.equal(revokedOwner.profile.founder_age, undefined, "unsafe shared CODEF path stays disabled");
assert.equal(revokedOwner.sourceReceipts.find((receipt) => receipt.source === "popbill_refresh")?.state, "not_authorized");
assert.equal(revokedOwner.sourceReceipts.find((receipt) => receipt.source === "codef_hometax")?.state, "disabled");

activeConsents = [activeConsent("basic_info")];
const consentedOwner = await resolveProductCompanyProfile({
  context: "owned_read",
  companyId,
  userId: ownerUserId,
  asOf,
}, dependencies);
assert.equal(consentedOwner.profile.revenue_krw, 1_200_000_000);
assert.equal(consentedOwner.profile.founder_age, undefined);

await assert.rejects(
  () => resolveProductCompanyProfile({
    context: "owned_read",
    companyId: "company-other",
    userId: ownerUserId,
    asOf,
  }, dependencies),
  (error: unknown) => error instanceof ProductProfileResolutionError &&
    error.code === "company_forbidden" && error.status === 403,
);

activeConsents = [];
const refreshCallsBeforeDenied = refreshCalls;
await assert.rejects(
  () => resolveProductCompanyProfile({
    context: "owned_refresh",
    companyId,
    userId: ownerUserId,
    bizNo: "7465400870",
    source: "popbill_refresh",
    asOf,
  }, dependencies),
  (error: unknown) => error instanceof ProductProfileResolutionError &&
    error.code === "consent_required" && error.status === 403,
);
assert.equal(refreshCalls, refreshCallsBeforeDenied, "missing consent must fail before live acquisition");

activeConsents = [activeConsent("basic_info")];
const refreshed = await resolveProductCompanyProfile({
  context: "owned_refresh",
  companyId,
  userId: ownerUserId,
  bizNo: "7465400870",
  source: "popbill_refresh",
  asOf,
}, dependencies);
assert.equal(refreshCalls, refreshCallsBeforeDenied + 1);
assert.equal(saves, 1);
assert.equal(refreshed.persistence, "saved");
assert.equal(refreshed.profile.profile_evidence?.business_status?.persistenceClass, "versioned_provider_observation");

const companyScoped = await resolveSystemProductCompanyProfile({
  companyId,
  asOf,
}, {
  companies: dependencies.companies,
  enrichmentCache: dependencies.enrichmentCache,
});
assert.equal(companyScoped.profile.employees_count, undefined, "company state must not absorb a user overlay");
assert.equal(companyScoped.profile.size, undefined, "company state must not absorb a legacy user overlay");
assert.equal(companyScoped.stateScope, "company");

assert.equal(PRODUCT_PROFILE_SOURCE_POLICIES.find((policy) => policy.id === "nice_demo")?.classification, "disabled");
assert.equal(PRODUCT_PROFILE_SOURCE_POLICIES.some((policy) => String(policy.classification) === "pending"), false);

console.log("productProfile/resolveProductCompanyProfile.test.ts: all assertions passed");

function observation(
  provider: string,
  scope: "shared" | "user",
  confidence: number,
): NonNullable<CompanyProfile["profile_evidence"]>[keyof NonNullable<CompanyProfile["profile_evidence"]>] & {} {
  return {
    sourceKind: "authoritative_api",
    provider,
    scope,
    asOf,
    axisCompleteness: "complete",
    confidence,
    observationVersion: "fixture-v1",
    persistenceClass: "versioned_provider_observation",
    resolverVersion: "p1-v1",
  };
}

function cacheEntry(profile: CompanyProfile): EnrichmentCacheEntry {
  return {
    provider: "popbill",
    bizNo: "7465400870",
    scope: "checkBizInfo",
    canonicalPayload: {
      profile: profile as unknown as Record<string, unknown>,
      facts: { maskedBizNo: "746-**-00***" },
    },
    rawPayload: { access_token: "must-never-be-read" },
    fetchedAt: new Date(asOf),
    checkedAt: new Date(asOf),
    expiresAt: new Date("2026-08-14T00:00:00.000Z"),
  };
}

function activeConsent(scope: ConsentRecordDto["scope"]): ConsentRecordDto {
  return {
    scope,
    purpose: "테스트",
    grantedAt: asOf,
    revokedAt: null,
  };
}
