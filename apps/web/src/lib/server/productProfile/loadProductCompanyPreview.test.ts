import assert from "node:assert/strict";
import type { CompanyEvidence, CompanyProfile } from "@cunote/contracts";
import {
  buildMatchingProfileView,
  ProductProfileResolutionError,
  type ResolvedProductCompanyProfile,
} from "./resolveProductCompanyProfile";
import { loadProductCompanyPreview, ServiceDataError } from "../serviceData";

const asOf = new Date("2026-07-14T12:00:00.000Z");
const bizNo = "7465400870";
const profile: CompanyProfile = {
  name: "테스트 주식회사",
  region: { code: "11", label: "서울특별시" },
  business_status: { active: true, label: "계속사업자" },
};

let resolveCalls = 0;
let acquisitionCalls = 0;
const cacheHit = await loadProductCompanyPreview(bizNo, {
  asOf,
  dependencies: {
    async resolveAnonymous() {
      resolveCalls += 1;
      return resolvedProfile();
    },
    async acquirePublicBase() {
      acquisitionCalls += 1;
      throw new Error("cache hit must not acquire a provider result");
    },
  },
});
assert.equal(cacheHit.name, profile.name);
assert.equal(cacheHit.cacheStatus, "hit");
assert.equal(resolveCalls, 1);
assert.equal(acquisitionCalls, 0);

resolveCalls = 0;
acquisitionCalls = 0;
const acquired = await loadProductCompanyPreview(bizNo, {
  asOf,
  publicRequestKey: "test-public-client",
  dependencies: {
    async resolveAnonymous() {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        throw unavailableProfile();
      }
      return resolvedProfile();
    },
    async acquirePublicBase(requestedBizNo, options) {
      acquisitionCalls += 1;
      assert.equal(requestedBizNo, bizNo);
      assert.equal(options.asOf, asOf);
      assert.equal(options.publicRequestKey, "test-public-client");
      return { profile, evidence: storedEvidence() };
    },
  },
});
assert.equal(acquired.name, profile.name);
assert.equal(acquired.cacheStatus, "stored");
assert.equal(resolveCalls, 2, "cache miss must re-enter the resolver after one explicit acquisition");
assert.equal(acquisitionCalls, 1, "company preview must acquire at most once per cache miss request");

const unrelatedError = new ProductProfileResolutionError(
  "company_access_unavailable",
  "회사 접근 권한을 확인하지 못했습니다.",
  503,
);
acquisitionCalls = 0;
await assert.rejects(
  () => loadProductCompanyPreview(bizNo, {
    asOf,
    dependencies: {
      async resolveAnonymous() {
        throw unrelatedError;
      },
      async acquirePublicBase() {
        acquisitionCalls += 1;
        return { profile, evidence: storedEvidence() };
      },
    },
  }),
  (error: unknown) => error === unrelatedError,
);
assert.equal(acquisitionCalls, 0, "non-cache-miss failures must never trigger acquisition");

const providerError = new ServiceDataError(
  "popbill_lookup_failed",
  "사업자 정보를 즉시 확인하지 못했습니다.",
  503,
  "bizNo",
);
resolveCalls = 0;
await assert.rejects(
  () => loadProductCompanyPreview(bizNo, {
    asOf,
    dependencies: {
      async resolveAnonymous() {
        resolveCalls += 1;
        throw unavailableProfile();
      },
      async acquirePublicBase() {
        throw providerError;
      },
    },
  }),
  (error: unknown) => error === providerError,
);
assert.equal(resolveCalls, 1, "provider failure must be returned without a retry loop");

resolveCalls = 0;
acquisitionCalls = 0;
const unstored = await loadProductCompanyPreview(bizNo, {
  asOf,
  dependencies: {
    async resolveAnonymous() {
      resolveCalls += 1;
      throw unavailableProfile();
    },
    async acquirePublicBase() {
      acquisitionCalls += 1;
      return {
        profile,
        evidence: { ...storedEvidence(), cacheStatus: "none", cachedUntil: null },
      };
    },
  },
});
assert.equal(unstored.name, profile.name);
assert.equal(unstored.cacheStatus, "none");
assert.equal(resolveCalls, 1, "an unstored paid result must not enter a cache-only resolver again");
assert.equal(acquisitionCalls, 1, "an unstored paid result must not be reacquired in the same request");

console.log("productProfile/loadProductCompanyPreview.test.ts: all assertions passed");

function resolvedProfile(): ResolvedProductCompanyProfile {
  return {
    context: "anonymous_teaser",
    asOf: asOf.toISOString(),
    stateScope: "request",
    profile,
    decisions: [],
    view: buildMatchingProfileView(profile, asOf.toISOString()),
    sourceReceipts: [{
      source: "popbill_cache",
      state: "consumed",
      observationCount: 2,
      reason: "materialized",
    }],
    persistence: "none",
    refreshStatus: "not_requested",
  };
}

function unavailableProfile(): ProductProfileResolutionError {
  return new ProductProfileResolutionError(
    "product_profile_unavailable",
    "안전하게 사용할 수 있는 회사 프로필을 찾지 못했습니다.",
    503,
    "bizNo",
  );
}

function storedEvidence(): CompanyEvidence {
  return {
    provider: "popbill",
    source: "popbill_live",
    cacheStatus: "stored",
    checkedAt: asOf.toISOString(),
    cachedUntil: "2026-08-13T12:00:00.000Z",
    maskedBizNo: "746-**-00***",
    resultMessage: null,
    fields: [],
    summary: "명시적 회사 확인으로 공개 기본정보를 조회했습니다.",
  };
}
