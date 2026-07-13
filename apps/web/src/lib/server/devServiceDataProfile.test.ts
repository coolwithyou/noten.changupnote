import assert from "node:assert/strict";
import {
  matchGrantCriteria,
  updateCompanyProfileField,
  type CompanyProfileFieldUpdate,
} from "@cunote/core";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import {
  buildCertificationProfileUpdates,
  buildInsuredWorkforceProfileUpdates,
  buildRevenueProfileUpdates,
  type DevServiceDataProfileMetadata,
  type DevServiceDataProfileNormalization,
} from "./devServiceDataProfile";

const metadata: DevServiceDataProfileMetadata = {
  sourceKind: "authoritative_api",
  provider: "dart",
  asOf: "2026-06-30",
  confidence: 0.9,
  axisCompleteness: "complete",
};

const revenue = success(buildRevenueProfileUpdates(1_234_567_890.9, metadata));
assert.deepEqual(revenue[0], {
  field: "revenue",
  value: 1_234_567_890,
  confidence: 0.9,
  sourceKind: "authoritative_api",
  provider: "dart",
  asOf: "2026-06-30",
  axisCompleteness: "complete",
});
const revenueProfile = apply(revenue);
assert.equal(revenueProfile.revenue_krw, 1_234_567_890, "revenue는 원 단위 scalar여야 한다");
assert.deepEqual(revenueProfile.profile_evidence?.revenue, {
  sourceKind: "authoritative_api",
  provider: "dart",
  asOf: "2026-06-30",
  axisCompleteness: "complete",
  confidence: 0.9,
});

const invalidRevenue = buildRevenueProfileUpdates("12억원", metadata);
assert.equal(invalidRevenue.ok, false);
if (!invalidRevenue.ok) {
  assert.equal(invalidRevenue.failure.code, "normalization_failed");
  assert.equal(invalidRevenue.failure.field, "revenue");
}

const partialCertification = success(buildCertificationProfileUpdates(
  ["창업기업확인서", "창업기업확인서"],
  { ...metadata, provider: "startup_confirmation", axisCompleteness: "partial" },
));
assert.equal(partialCertification[0]?.mode, "merge");
const partialCertificationProfile = apply(partialCertification);
assert.deepEqual(partialCertificationProfile.certs, ["창업기업확인서"]);
assert.equal(partialCertificationProfile.list_completeness?.certification, "partial");
assert.equal(partialCertificationProfile.profile_evidence?.certification?.provider, "startup_confirmation");

const presentOnlyMiss = success(buildCertificationProfileUpdates(
  [],
  { ...metadata, provider: "registry", axisCompleteness: "partial" },
));
assert.deepEqual(presentOnlyMiss, [], "present-only miss는 인증 미보유 update를 만들면 안 된다");

const exhaustiveMiss = success(buildCertificationProfileUpdates(
  [],
  { ...metadata, provider: "exhaustive_registry", axisCompleteness: "complete" },
));
assert.equal(exhaustiveMiss[0]?.mode, "replace");
const exhaustiveProfile = apply(exhaustiveMiss);
assert.deepEqual(exhaustiveProfile.certs, []);
assert.equal(exhaustiveProfile.list_completeness?.certification, "complete");

const layoffKnownWithoutDate = success(buildInsuredWorkforceProfileUpdates(
  {
    employment_insurance_active: true,
    insured_count: 12.9,
    no_layoff: false,
  },
  { ...metadata, provider: "kcomwel", axisCompleteness: "partial" },
));
const workforceProfile = apply(layoffKnownWithoutDate);
assert.deepEqual(workforceProfile.insured_workforce, {
  employment_insurance_active: true,
  insured_count: 12,
  no_layoff: false,
});
assert.equal(workforceProfile.profile_evidence?.insured_workforce?.provider, "kcomwel");

const layoffCriterion: GrantCriterion = {
  id: "insured-no-layoff",
  grant_id: "grant-1",
  dimension: "insured_workforce",
  kind: "required",
  operator: "gte",
  value: { no_layoff_within_months: 6 },
  confidence: 1,
};
assert.equal(
  matchGrantCriteria([layoffCriterion], workforceProfile).rule_trace[0]?.result,
  "unknown",
  "감원 사실만 있고 시점이 없으면 matcher unknown을 유지해야 한다",
);

const workforceWithMonths = success(buildInsuredWorkforceProfileUpdates(
  { no_layoff: false, months_since_last_layoff: 8.7 },
  { ...metadata, provider: "user", sourceKind: "self_declared", confidence: 0.6 },
));
assert.equal(apply(workforceWithMonths).insured_workforce?.months_since_last_layoff, 8);

const invalidCount = buildInsuredWorkforceProfileUpdates(
  { insured_count: -1 },
  { ...metadata, provider: "kcomwel", axisCompleteness: "partial" },
);
assert.equal(invalidCount.ok, false);
if (!invalidCount.ok) assert.equal(invalidCount.failure.code, "normalization_failed");

function success(result: DevServiceDataProfileNormalization): CompanyProfileFieldUpdate[] {
  assert.equal(result.ok, true, result.ok ? undefined : result.failure.message);
  return result.ok ? result.profileUpdates : [];
}

function apply(updates: CompanyProfileFieldUpdate[]): CompanyProfile {
  return updates.reduce<CompanyProfile>(
    (profile, update) => updateCompanyProfileField(profile, update),
    { confidence: {} },
  );
}

console.log("devServiceDataProfile.test.ts: all assertions passed");
