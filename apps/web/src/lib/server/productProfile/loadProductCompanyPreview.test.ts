import assert from "node:assert/strict";
import type { CompanyEvidence, CompanyProfile } from "@cunote/contracts";
import {
  buildMatchingProfileView,
  ProductProfileResolutionError,
  type ResolvedProductCompanyProfile,
} from "./resolveProductCompanyProfile";
import {
  loadProductCompanyPreview,
  resolveAnonymousProductCompanyProfile,
  ServiceDataError,
} from "../serviceData";

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

resolveCalls = 0;
acquisitionCalls = 0;
const virtual = await loadProductCompanyPreview("0000000001", {
  asOf,
  allowVirtual: true,
  dependencies: {
    async resolveAnonymous() {
      resolveCalls += 1;
      throw new Error("virtual company must not enter the real resolver");
    },
    async acquirePublicBase() {
      acquisitionCalls += 1;
      throw new Error("virtual company must not acquire provider data");
    },
  },
});
assert.equal(virtual.name, "창업노트 가상기업 — 충남 장애인기업");
assert.equal(virtual.cacheStatus, "virtual");
assert.equal(resolveCalls, 0);
assert.equal(acquisitionCalls, 0);

await assert.rejects(
  () => loadProductCompanyPreview("0000000001", { asOf, allowVirtual: false }),
  (error: unknown) => error instanceof ServiceDataError && error.code === "invalid_biz_no",
);

const virtualResolution = await resolveAnonymousProductCompanyProfile(
  { bizNo: "0000000003", answers: [{ field: "certification", value: ["장애인기업 확인서"] }] },
  { asOf, allowVirtual: true },
);
assert.deepEqual(virtualResolution.profile.certs, ["장애인기업 확인서"]);
assert.equal(virtualResolution.profile.region?.code, "44");
assert.equal(virtualResolution.sourceReceipts[0]?.reason, "virtual_company_fixture");

const tenDaysAgo = new Date(asOf.getTime() - 10 * 24 * 60 * 60 * 1000);
const withinHour = new Date(asOf.getTime() - 30 * 60 * 1000);
const cooldownUntil = new Date(asOf.getTime() + 12 * 60 * 60 * 1000);

let refreshPopbillCalls = 0;
let refreshAcquireCalls = 0;
const alreadyFresh = await loadProductCompanyPreview(bizNo, {
  asOf,
  refresh: true,
  dependencies: refreshDependencies({
    liveCheckedAt: withinHour,
    cooldownExpiresAt: null,
    onPopbill() {
      refreshPopbillCalls += 1;
      throw new Error("already fresh must not call popbill");
    },
    onAcquire() {
      refreshAcquireCalls += 1;
    },
  }),
});
assert.equal(alreadyFresh.refreshResult, "already_fresh");
assert.equal(alreadyFresh.name, profile.name);
assert.equal(refreshPopbillCalls, 0);
assert.equal(refreshAcquireCalls, 0);

refreshPopbillCalls = 0;
const rateLimited = await loadProductCompanyPreview(bizNo, {
  asOf,
  refresh: true,
  dependencies: refreshDependencies({
    liveCheckedAt: tenDaysAgo,
    cooldownExpiresAt: cooldownUntil,
    onPopbill() {
      refreshPopbillCalls += 1;
      throw new Error("rate limited refresh must not call popbill");
    },
  }),
});
assert.equal(rateLimited.refreshResult, "rate_limited");
assert.equal(rateLimited.name, profile.name);
assert.equal(refreshPopbillCalls, 0);

refreshPopbillCalls = 0;
let refreshedName = profile.name ?? "";
const updated = await loadProductCompanyPreview(bizNo, {
  asOf,
  refresh: true,
  publicRequestKey: "refresh-client",
  dependencies: refreshDependencies({
    liveCheckedAt: tenDaysAgo,
    cooldownExpiresAt: null,
    async onPopbill(requestedBizNo, refreshOptions) {
      refreshPopbillCalls += 1;
      assert.equal(requestedBizNo, bizNo);
      assert.equal(refreshOptions.asOf, asOf);
      assert.equal(refreshOptions.publicRequestKey, "refresh-client");
      refreshedName = "바뀐 상호";
      return {
        profile: { ...profile, name: "바뀐 상호" },
        evidence: storedEvidence(),
        refreshResult: "updated" as const,
      };
    },
    resolveName: () => refreshedName,
  }),
});
assert.equal(updated.refreshResult, "updated");
assert.equal(updated.name, "바뀐 상호");
assert.equal(refreshPopbillCalls, 1);
assert.equal(updated.cacheStatus, "stored");

refreshPopbillCalls = 0;
const unchanged = await loadProductCompanyPreview(bizNo, {
  asOf,
  refresh: true,
  dependencies: refreshDependencies({
    liveCheckedAt: tenDaysAgo,
    cooldownExpiresAt: null,
    async onPopbill() {
      refreshPopbillCalls += 1;
      return { profile, evidence: storedEvidence() };
    },
  }),
});
assert.equal(unchanged.refreshResult, "unchanged");
assert.equal(unchanged.name, profile.name);
assert.equal(refreshPopbillCalls, 1);

refreshPopbillCalls = 0;
const failedRefresh = await loadProductCompanyPreview(bizNo, {
  asOf,
  refresh: true,
  dependencies: refreshDependencies({
    liveCheckedAt: tenDaysAgo,
    cooldownExpiresAt: null,
    async onPopbill() {
      refreshPopbillCalls += 1;
      throw providerError;
    },
  }),
});
assert.equal(failedRefresh.refreshResult, "failed");
assert.equal(failedRefresh.name, profile.name);
assert.equal(refreshPopbillCalls, 1);

refreshPopbillCalls = 0;
const virtualRefresh = await loadProductCompanyPreview("0000000001", {
  asOf,
  allowVirtual: true,
  refresh: true,
  dependencies: refreshDependencies({
    liveCheckedAt: tenDaysAgo,
    cooldownExpiresAt: null,
    onPopbill() {
      refreshPopbillCalls += 1;
      throw new Error("virtual refresh must not call popbill");
    },
  }),
});
assert.equal(virtualRefresh.name, "창업노트 가상기업 — 충남 장애인기업");
assert.equal(virtualRefresh.cacheStatus, "virtual");
assert.equal(virtualRefresh.refreshResult, undefined);
assert.equal(refreshPopbillCalls, 0);

await assert.rejects(
  () => loadProductCompanyPreview("1234567890", {
    asOf,
    refresh: true,
    dependencies: refreshDependencies({
      liveCheckedAt: tenDaysAgo,
      cooldownExpiresAt: null,
      onPopbill() {
        throw new Error("invalid refresh must not call popbill");
      },
    }),
  }),
  (error: unknown) => error instanceof ServiceDataError && error.code === "invalid_biz_no",
);

console.log("productProfile/loadProductCompanyPreview.test.ts: all assertions passed");

function resolvedProfile(name?: string): ResolvedProductCompanyProfile {
  const nextProfile = name ? { ...profile, name } : profile;
  return {
    context: "anonymous_teaser",
    asOf: asOf.toISOString(),
    stateScope: "request",
    profile: nextProfile,
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

function refreshDependencies(input: {
  liveCheckedAt: Date;
  cooldownExpiresAt: Date | null;
  onPopbill: (
    bizNo: string,
    options: { asOf?: Date; publicRequestKey?: string },
  ) => Promise<{ profile: CompanyProfile; evidence: CompanyEvidence; refreshResult?: "updated" }>;
  onAcquire?: () => void;
  resolveName?: () => string;
}) {
  return {
    async resolveAnonymous() {
      const name = input.resolveName?.() ?? profile.name;
      return resolvedProfile(name ?? undefined);
    },
    async acquirePublicBase() {
      input.onAcquire?.();
      throw new Error("refresh must not use cache-first acquisition");
    },
    async readRefreshContext() {
      return {
        liveCheckedAt: input.liveCheckedAt,
        cooldownExpiresAt: input.cooldownExpiresAt,
      };
    },
    refreshPublicBase: input.onPopbill,
  };
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
