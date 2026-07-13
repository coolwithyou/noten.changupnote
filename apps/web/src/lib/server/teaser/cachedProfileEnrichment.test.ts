import assert from "node:assert/strict";
import type { EnrichmentCacheEntry } from "@cunote/core";
import { mergeCompanyProfilesForEnrichment } from "../serviceData";
import { buildCachedTeaserProfileEnrichment } from "./cachedProfileEnrichment";

const checkedAt = new Date("2026-07-13T00:00:00.000Z");
const cached = buildCachedTeaserProfileEnrichment([
  entry("apick", "bizDetail", {
    profile: {
      name: "주식회사 마스트온",
      region: { code: "41", label: "경기" },
      biz_age_months: 19,
      industries: ["건설업", "주택건설업"],
      industry_codes: ["F41119", "41", "F"],
      employees_count: 4,
      other_conditions: { apick_company_type: "법인사업자" },
      confidence: { region: 0.85, biz_age: 0.85, industry: 0.85, employees: 0.65 },
    },
    facts: {},
  }),
  entry("kised", "startup-confirmation", {
    state: "active",
    exactRecordCount: 1,
    record: { issuedOn: "20260708", expiresOn: "20290707" },
  }),
  entry("kipris", "applicant-business-number", {
    version: 2,
    found: true,
    match: { applicantNumber: "masked", businessRegistrationNumber: "masked" },
    rights: {
      patentUtility: { totalCount: 0 },
      design: { totalCount: 0 },
      trademark: { totalCount: 1 },
      totalCount: 1,
      truncated: false,
    },
  }),
]);

assert.deepEqual(cached.providers, ["apick", "startup_confirmation", "kipris"]);
const merged = cached.profiles.reduce(mergeCompanyProfilesForEnrichment, {
  industries: ["사용자 확정 업종"],
  confidence: { industry: 0.7 },
  list_completeness: { industry: "complete" },
  profile_evidence: {
    industry: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: checkedAt.toISOString(),
      axisCompleteness: "complete",
      confidence: 0.7,
    },
  },
});
assert.equal(merged.name, "주식회사 마스트온");
assert.deepEqual(merged.region, { code: "41", label: "경기" });
assert.equal(merged.biz_age_months, 19);
assert.equal(merged.employees_count, 4);
assert.deepEqual(merged.industries, ["사용자 확정 업종"], "partial APICK 업종이 complete 사용자 값을 덮으면 안 된다");
assert.deepEqual(merged.certs, ["창업기업확인서"]);
assert.deepEqual(merged.target_types, ["법인", "창업기업"]);
assert.deepEqual(merged.ip, ["상표"]);
assert.equal(merged.profile_evidence?.certification?.provider, "startup_confirmation");
assert.equal(merged.profile_evidence?.ip?.provider, "kipris");
assert.equal(merged.other_conditions?.startup_confirmation_expires_on, "20290707");
assert.equal(merged.other_conditions?.kipris_trademark_count, 1);

const negatives = buildCachedTeaserProfileEnrichment([
  entry("kised", "startup-confirmation", { state: "none", exactRecordCount: 0, record: null }),
  entry("kipris", "applicant-business-number", { version: 2, found: false, match: null, rights: null }),
]);
assert.deepEqual(negatives, { profiles: [], providers: [] }, "부재 응답은 complete negative로 과장하면 안 된다");

console.log("cachedProfileEnrichment.test.ts: all assertions passed");

function entry(provider: string, scope: string, canonicalPayload: Record<string, unknown>): EnrichmentCacheEntry {
  return {
    provider,
    bizNo: "masked",
    scope,
    canonicalPayload,
    checkedAt,
    fetchedAt: checkedAt,
    expiresAt: new Date("2026-08-13T00:00:00.000Z"),
  };
}
