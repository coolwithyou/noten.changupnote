import assert from "node:assert/strict";
import {
  legacyAccountLoginHref,
  legacyAccountSection,
  normalizeSettingsSection,
  settingsPath,
} from "./settingsDeepLink";

assert.equal(normalizeSettingsSection("company"), "company");
assert.equal(normalizeSettingsSection(["data", "activity"]), "data");
assert.equal(normalizeSettingsSection("https://evil.example"), null);
assert.equal(settingsPath("activity"), "/settings?section=activity");
assert.equal(legacyAccountSection("#account-deletion-request"), "data");
assert.equal(legacyAccountSection("#account-support-tickets"), "activity");
assert.equal(legacyAccountSection("#unknown"), null);
assert.equal(
  legacyAccountLoginHref("#account-deletion-request"),
  "/login?callbackUrl=%2Fsettings%3Fsection%3Ddata",
);
assert.equal(legacyAccountLoginHref("#//evil.example"), "/login?callbackUrl=%2Fsettings");

console.log("settings deep link tests passed");
