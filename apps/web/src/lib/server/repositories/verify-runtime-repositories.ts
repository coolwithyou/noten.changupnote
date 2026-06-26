import assert from "node:assert/strict";
import { updateCompanyProfileField } from "@cunote/core";
import type { CompanyProfile } from "@cunote/contracts";
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

const repositories = createRuntimeRepositories({
  async loadGrants() {
    return [];
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

const companies = await repositories.companies.listUserCompanies(userId);
assert.equal(companies[0]?.profile.biz_age_months, 42);
assert.equal(companies[0]?.profile.confidence?.biz_age, 0.92);

const outsideCompany = await repositories.companies.resolveCompanyProfile({
  companyId: "00000000-0000-4000-8000-000000000999",
  userId,
});
assert.equal(outsideCompany, null);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "runtime_profile_save",
    "runtime_profile_resolve",
    "runtime_list_user_companies",
    "runtime_company_guard",
  ],
  companyId: demoCompanyId(),
  bizAgeMonths: resolvedAgain?.biz_age_months,
}, null, 2));
