import assert from "node:assert/strict";
import { ConsentRequiredError, getConsentStore, requireActiveConsent } from "./consentStore";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";

const companyId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000001";
const store = getConsentStore();

await assert.rejects(
  () => requireActiveConsent({ companyId, userId, scope: "basic_info" }),
  (error) => error instanceof ConsentRequiredError && error.code === "consent_required",
  "basic_info consent should be required before enrichment",
);

const granted = await store.grantConsent({
  companyId,
  userId,
  scope: "basic_info",
});
assert.equal(granted.scope, "basic_info");
assert.equal(granted.revokedAt, null);

await requireActiveConsent({ companyId, userId, scope: "basic_info" });

assert.equal(await store.revokeConsent({ companyId, userId, scope: "basic_info" }), true);

await assert.rejects(
  () => requireActiveConsent({ companyId, userId, scope: "basic_info" }),
  (error) => error instanceof ConsentRequiredError && error.scope === "basic_info",
  "revoked basic_info consent should block enrichment",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "consent_required_before_grant",
    "consent_allows_after_grant",
    "consent_blocks_after_revoke",
  ],
  companyId,
  scope: "basic_info",
}, null, 2));
