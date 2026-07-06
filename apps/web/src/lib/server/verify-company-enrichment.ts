import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import { mergeCompanyProfilesForEnrichment } from "./serviceData";

const current: CompanyProfile = {
  id: "company-1",
  name: "기존 회사",
  region: { code: "11", label: "서울" },
  biz_age_months: 18,
  founder_age: 35,
  industries: ["기존 업종"],
  traits: ["여성기업"],
  confidence: {
    region: 0.4,
    biz_age: 0.5,
    founder_age: 0.8,
  },
};

const enriched: CompanyProfile = {
  id: "popbill:123-**-67***",
  name: "보강 회사",
  region: { code: "41", label: "경기" },
  biz_age_months: 42,
  industries: ["정보통신업", "소프트웨어 개발"],
  industry_codes: ["J62", "62", "J"],
  size: "중소기업",
  business_status: {
    active: true,
    label: "정상",
  },
  confidence: {
    region: 0.8,
    biz_age: 0.75,
    industry: 0.7,
    size: 0.65,
    business_status: 0.8,
  },
};

const merged = mergeCompanyProfilesForEnrichment(current, enriched);

assert.equal(merged.id, "company-1");
assert.equal(merged.name, "보강 회사");
assert.deepEqual(merged.region, { code: "41", label: "경기" });
assert.equal(merged.biz_age_months, 42);
assert.equal(merged.founder_age, 35);
assert.deepEqual(merged.industries, ["정보통신업", "소프트웨어 개발"]);
assert.deepEqual(merged.industry_codes, ["J62", "62", "J"]);
assert.deepEqual(merged.traits, ["여성기업"]);
assert.equal(merged.size, "중소기업");
assert.equal(merged.business_status?.active, true);
assert.equal(merged.confidence?.founder_age, 0.8);
assert.equal(merged.confidence?.region, 0.8);
assert.equal(merged.confidence?.industry, 0.7);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "enrichment_preserves_company_id",
    "enrichment_overwrites_verified_fields",
    "enrichment_preserves_manual_fields",
    "enrichment_merges_confidence",
  ],
  region: merged.region,
  bizAgeMonths: merged.biz_age_months,
  industriesCount: merged.industries?.length ?? 0,
}, null, 2));
