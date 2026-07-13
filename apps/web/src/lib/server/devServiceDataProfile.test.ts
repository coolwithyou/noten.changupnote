import assert from "node:assert/strict";
import {
  matchGrantCriteria,
  normalizeCompanyIndustryProfile,
  questionDefinitionFor,
  updateCompanyProfileField,
  type CompanyProfileFieldUpdate,
} from "@cunote/core";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import {
  buildCertificationProfileUpdates,
  buildDevQnaProfileUpdates,
  buildFinancialHealthProfileUpdates,
  buildIndustryProfileUpdates,
  buildInsuredWorkforceProfileUpdates,
  buildIpProfileUpdates,
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

const partialIndustry = success(buildIndustryProfileUpdates(
  { labels: ["소프트웨어"], codes: ["62010", "62", "J"] },
  { ...metadata, provider: "codef", axisCompleteness: "partial" },
));
assert.equal(partialIndustry[0]?.mode, "merge");

const kiprisKinds = success(buildIpProfileUpdates(
  ["특허·실용신안", "디자인"],
  { ...metadata, provider: "kipris", axisCompleteness: "partial" },
));
assert.deepEqual(apply(kiprisKinds).ip, ["특허·실용신안", "디자인"]);
assert.deepEqual(
  success(buildIpProfileUpdates([], { ...metadata, provider: "kipris", axisCompleteness: "partial" })),
  [],
  "KIPRIS miss/권리 0건은 미보유를 확정하지 않고 unknown으로 남겨야 한다",
);

const derivedFinancial = success(buildFinancialHealthProfileUpdates(
  {
    equity_krw: 1_000_000_000,
    capital_krw: 2_000_000_000,
    interest_coverage_ratio: -0.4,
    fiscal_year: "2025",
  },
  { ...metadata, provider: "qna", sourceKind: "self_declared", axisCompleteness: "partial" },
));
assert.deepEqual(apply(derivedFinancial).financial_health, {
  impairment: "partial",
  interest_coverage_ratio: -0.4,
  equity_krw: 1_000_000_000,
  capital_krw: 2_000_000_000,
  fiscal_year: "2025",
});
assert.equal(buildFinancialHealthProfileUpdates(
  { impairment: "none", equity_krw: 1_000_000_000, capital_krw: 2_000_000_000 },
  { ...metadata, provider: "qna", sourceKind: "self_declared", axisCompleteness: "partial" },
).ok, false, "자가신고 잠식 상태가 결산 수치와 충돌하면 묵시적으로 정상 처리하면 안 된다");

const id = (dimension: Parameters<typeof questionDefinitionFor>[0]) => questionDefinitionFor(dimension).id;
const qna = buildDevQnaProfileUpdates({
  scenario: "registered_business",
  answers: [
    { definitionId: id("industry"), value: { labels: ["소프트웨어"], codes: ["62010", "62", "J"] } },
    { definitionId: id("founder_trait"), value: ["청년"] },
    { definitionId: id("certification"), value: ["벤처기업확인서"] },
    {
      definitionId: id("prior_award"),
      value: {
        records: [{ program: "TIPS", agency: "중기부", year: 2025, state: "completed" }],
        known_programs: ["TIPS"],
        known_program_types: [],
        self_flags: { current_similar: false },
      },
    },
    { definitionId: id("ip"), value: ["특허·실용신안"] },
    { definitionId: id("target_type"), value: ["창업기업"] },
    {
      definitionId: id("financial_health"),
      value: {
        equity_krw: 1_000_000_000,
        capital_krw: 2_000_000_000,
        interest_coverage_ratio: 1.75,
        fiscal_year: "2025",
      },
    },
    {
      definitionId: id("insured_workforce"),
      value: { no_layoff: false, months_since_last_layoff: 8 },
    },
  ],
}, { now: new Date("2026-07-14T00:00:00.000Z") });
assert.deepEqual(qna.failures, []);
const qnaProfile = applyQna(qna.profileUpdates);
assert.deepEqual(qnaProfile.industries, ["소프트웨어"]);
assert.deepEqual(qnaProfile.industry_codes, ["62010", "62", "J"]);
assert.equal(qnaProfile.prior_award_history?.records[0]?.program, "tips");
assert.deepEqual(qnaProfile.prior_award_history?.known_programs, ["tips"]);
assert.equal(qnaProfile.prior_award_history?.self_flags?.current_similar, false);
assert.equal(qnaProfile.financial_health?.impairment, "partial");
assert.equal(qnaProfile.financial_health?.interest_coverage_ratio, 1.75);
assert.equal(qnaProfile.financial_health?.capital_krw, 2_000_000_000);
assert.equal(qnaProfile.financial_health?.fiscal_year, "2025");
assert.equal(qnaProfile.insured_workforce?.months_since_last_layoff, 8);
for (const dimension of [
  "industry",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
] as const) {
  assert.equal(
    qnaProfile.list_completeness?.[dimension],
    "partial",
    `${dimension} Q&A 목록은 답한 범위만 known인 partial이어야 한다`,
  );
}

const queriedProgramMiss = buildDevQnaProfileUpdates({
  scenario: "registered_business",
  answers: [{
    definitionId: id("prior_award"),
    value: { records: [], known_programs: ["TIPS"], known_program_types: [] },
  }],
});
const queriedProgramMissProfile = applyQna(queriedProgramMiss.profileUpdates);
assert.deepEqual(queriedProgramMissProfile.prior_award_history?.records, []);
assert.deepEqual(queriedProgramMissProfile.prior_award_history?.known_programs, ["tips"]);

const registeredWithoutTarget = buildDevQnaProfileUpdates({ scenario: "registered_business", answers: [] });
assert.equal(applyQna(registeredWithoutTarget.profileUpdates).target_types, undefined);
const preliminary = buildDevQnaProfileUpdates({ scenario: "preliminary", answers: [] });
const preliminaryProfile = applyQna(preliminary.profileUpdates);
assert.deepEqual(preliminaryProfile.target_types, ["예비창업자"]);
assert.equal(preliminaryProfile.list_completeness?.target_type, "partial");
const preliminaryWithApplicantTags = buildDevQnaProfileUpdates({
  scenario: "preliminary",
  answers: [{ definitionId: id("target_type"), value: ["여성기업"] }],
});
assert.deepEqual(
  applyQna(preliminaryWithApplicantTags.profileUpdates).target_types,
  ["여성기업", "예비창업자"],
  "preliminary 시나리오는 applicant tags 답변과 예비창업자 태그를 union해야 한다",
);

const authoritativeBase: CompanyProfile = {
  revenue_krw: 1_000_000_000,
  certs: ["공식인증"],
  financial_health: { capital_krw: 3_000_000_000 },
  confidence: { revenue: 0.95, certification: 0.95, financial_health: 0.95 },
  profile_evidence: {
    revenue: {
      sourceKind: "authoritative_api",
      provider: "nts",
      asOf: "2026-06-30",
      axisCompleteness: "complete",
      confidence: 0.95,
    },
    certification: {
      sourceKind: "public_registry",
      provider: "registry",
      asOf: "2026-06-30",
      axisCompleteness: "complete",
      confidence: 0.95,
    },
    financial_health: {
      sourceKind: "authoritative_api",
      provider: "fsc",
      asOf: "2026-06-30",
      axisCompleteness: "partial",
      confidence: 0.95,
    },
  },
};
const protectedQna = buildDevQnaProfileUpdates({
  scenario: "registered_business",
  answers: [
    { definitionId: id("revenue"), value: 2_000_000_000 },
    { definitionId: id("certification"), value: ["자가인증"] },
    { definitionId: id("financial_health"), value: { capital_krw: 1_000_000_000, fiscal_year: "2025" } },
  ],
}, { baseProfile: authoritativeBase, now: new Date("2026-07-14T00:00:00.000Z") });
const protectedProfile = applyQna(protectedQna.profileUpdates, authoritativeBase);
assert.equal(protectedProfile.revenue_krw, 1_000_000_000);
assert.ok(protectedQna.failures.some((failure) => failure.field === "revenue"));
assert.deepEqual(protectedProfile.certs, ["공식인증", "자가인증"]);
assert.equal(protectedProfile.profile_evidence?.certification?.sourceKind, "public_registry");
assert.equal(protectedProfile.profile_evidence?.certification?.supplemental?.[0]?.sourceKind, "self_declared");
assert.equal(protectedProfile.financial_health?.capital_krw, 3_000_000_000);
assert.equal(protectedProfile.financial_health?.fiscal_year, "2025");

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

function applyQna(
  updates: CompanyProfileFieldUpdate[],
  base: CompanyProfile = { confidence: {} },
): CompanyProfile {
  return updates.reduce<CompanyProfile>(
    (profile, update) => normalizeCompanyIndustryProfile(updateCompanyProfileField(profile, update)),
    base,
  );
}

console.log("devServiceDataProfile.test.ts: all assertions passed");
