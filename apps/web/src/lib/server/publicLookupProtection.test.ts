import assert from "node:assert/strict";
import {
  PublicLookupProtectionError,
  assertPublicLookupClientRate,
  publicLookupRequestKey,
  reservePublicLookupBudget,
} from "./publicLookupProtection";
import { createRuntimeRepositories } from "./repositories/runtime";

const env = {
  CREDIT_BIZNO_HMAC_PEPPER: "test-only-public-lookup-pepper",
  CUNOTE_PUBLIC_POPBILL_PER_CLIENT_HOURLY_LIMIT: "2",
  CUNOTE_PUBLIC_POPBILL_GLOBAL_DAILY_LIMIT: "3",
};
const request = new Request("https://changupnote.com/api/web/company-preview", {
  method: "POST",
  headers: {
    origin: "https://changupnote.com",
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.10",
  },
});
const clientKey = publicLookupRequestKey(request, { requireSameOrigin: true, env });
assert.equal(clientKey.length, 64);
assert.equal(clientKey.includes("203.0.113.10"), false, "raw client IP must not be retained");
assert.equal(
  publicLookupRequestKey(request, { requireSameOrigin: true, env }),
  clientKey,
  "the same client must receive a stable budget key",
);

assert.throws(
  () => publicLookupRequestKey(new Request("https://changupnote.com/api/web/company-preview", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
  }), { requireSameOrigin: true, env }),
  (error: unknown) => error instanceof PublicLookupProtectionError &&
    error.code === "public_lookup_origin_forbidden" && error.status === 403,
);

assert.throws(
  () => publicLookupRequestKey(request, { requireSameOrigin: true, env: {} }),
  (error: unknown) => error instanceof PublicLookupProtectionError &&
    error.code === "public_lookup_protection_unavailable" && error.status === 503,
);

assert.equal(
  publicLookupRequestKey(new Request("http://127.0.0.1:4010/api/web/company-preview", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:4010",
      "content-type": "application/json",
    },
  }), { requireSameOrigin: true, env }).length,
  64,
  "local production-credential smoke requests must still require their own origin",
);
assert.throws(
  () => publicLookupRequestKey(new Request("http://127.0.0.1:4010/api/web/company-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
  }), { requireSameOrigin: true, env }),
  (error: unknown) => error instanceof PublicLookupProtectionError &&
    error.code === "public_lookup_origin_forbidden" && error.status === 403,
);

const repositories = createRuntimeRepositories({
  async loadGrants() {
    return [];
  },
  async loadCompanyProfile() {
    return {};
  },
});
const now = new Date("2026-07-14T12:00:00.000Z");
assertPublicLookupClientRate({ clientKey, now, env });
assertPublicLookupClientRate({ clientKey, now, env });
assert.throws(
  () => assertPublicLookupClientRate({ clientKey, now, env }),
  (error: unknown) => error instanceof PublicLookupProtectionError &&
    error.code === "public_lookup_rate_limited" && error.status === 429,
);

await reservePublicLookupBudget({
  cache: repositories.enrichmentCache,
  clientKey,
  reservationKey: "reservation-a",
  now,
  env,
});
await reservePublicLookupBudget({
  cache: repositories.enrichmentCache,
  clientKey,
  reservationKey: "reservation-b",
  now,
  env,
});

const secondClientKey = publicLookupRequestKey(new Request(
  "https://changupnote.com/api/web/company-preview",
  {
    method: "POST",
    headers: {
      origin: "https://changupnote.com",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.11",
    },
  },
), { requireSameOrigin: true, env });
await reservePublicLookupBudget({
  cache: repositories.enrichmentCache,
  clientKey: secondClientKey,
  reservationKey: "reservation-c",
  now,
  env,
});
await assert.rejects(
  () => reservePublicLookupBudget({
    cache: repositories.enrichmentCache,
    clientKey: secondClientKey,
    reservationKey: "reservation-d",
    now,
    env,
  }),
  (error: unknown) => error instanceof PublicLookupProtectionError &&
    error.code === "public_lookup_budget_exhausted" && error.status === 429,
);

console.log("publicLookupProtection.test.ts: all assertions passed");
