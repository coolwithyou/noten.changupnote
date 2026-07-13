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
  buildDevFinalCompanyProfile,
  buildDevQnaProfileUpdates,
  buildFinancialHealthProfileUpdates,
  buildIndustryProfileUpdates,
  buildInsuredWorkforceProfileUpdates,
  buildIpProfileUpdates,
  buildRevenueProfileUpdates,
  sanitizeDevServiceDataJson,
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

// G3: connector 병합 뒤 그 결과를 Q&A base로 사용한다. 권위 scalar는 primary를
// 유지하되 충돌한 사용자 evidence를 버리지 않는다.
const authoritativeConflict = buildDevFinalCompanyProfile({
  baseProfile: authoritativeBase,
  connectorProfileUpdates: [],
  connectorSourcedDimensions: [],
  connectorNormalizedDimensions: [],
  qna: {
    answers: {
      scenario: "registered_business",
      answers: [{ definitionId: id("revenue"), value: 2_000_000_000 }],
    },
    asOf: "2026-07-14T00:00:00.000Z",
  },
});
assert.equal(authoritativeConflict.profilePreview.revenue_krw, 1_000_000_000);
assert.equal(authoritativeConflict.mergeDecisions[0]?.stage, "qna");
assert.equal(authoritativeConflict.mergeDecisions[0]?.valueDisposition, "retained");
assert.equal(authoritativeConflict.mergeDecisions[0]?.reason, "source_priority");
assert.equal(authoritativeConflict.profilePreview.profile_evidence?.revenue?.provider, "nts");
assert.equal(
  authoritativeConflict.profilePreview.profile_evidence?.revenue?.supplemental?.[0]?.sourceKind,
  "self_declared",
);
assert.deepEqual(authoritativeConflict.mergeOrder, ["connector", "qna"]);
assert.deepEqual(authoritativeConflict.fieldStates.find((state) => state.field === "revenue"), {
  field: "revenue",
  sourced: true,
  normalized: true,
  match_ready: true,
  product_consumed: "pending",
});

// Provider policy를 freshness보다 먼저 적용하고, 같은 provider 안에서만 asOf가
// tie-breaker가 된다. 같은 입력 replay는 decisions까지 동일해야 한다.
const providerBase: CompanyProfile = {
  revenue_krw: 1_000_000_000,
  confidence: { revenue: 0.9 },
  profile_evidence: {
    revenue: {
      sourceKind: "authoritative_api",
      provider: "dart",
      asOf: "2026-06-01T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.9,
    },
  },
};
const providerUpdates: CompanyProfileFieldUpdate[] = [
  {
    field: "revenue",
    value: 2_000_000_000,
    sourceKind: "authoritative_api",
    provider: "codef",
    asOf: "2026-05-01T00:00:00.000Z",
    axisCompleteness: "complete",
    confidence: 0.9,
  },
  {
    field: "revenue",
    value: 3_000_000_000,
    sourceKind: "authoritative_api",
    provider: "codef",
    asOf: "2026-07-01T00:00:00.000Z",
    axisCompleteness: "complete",
    confidence: 0.9,
  },
];
const providerMergeInput = {
  baseProfile: providerBase,
  connectorProfileUpdates: providerUpdates,
  connectorSourcedDimensions: ["revenue"] as const,
  connectorNormalizedDimensions: ["revenue"] as const,
};
const providerMerged = buildDevFinalCompanyProfile(providerMergeInput);
assert.equal(providerMerged.profilePreview.revenue_krw, 3_000_000_000);
assert.deepEqual(
  providerMerged.mergeDecisions.map((decision) => decision.reason),
  ["provider_priority", "same_provider_freshness"],
);
assert.deepEqual(
  buildDevFinalCompanyProfile(providerMergeInput),
  providerMerged,
  "동일 base와 ordered updates replay는 동일한 preview/decision을 반환해야 한다",
);

const unknownProviderTie = buildDevFinalCompanyProfile({
  baseProfile: {
    employees_count: 10,
    confidence: { employees: 0.8 },
    profile_evidence: {
      employees: {
        sourceKind: "authoritative_api",
        provider: "unknown-a",
        asOf: "2026-01-01T00:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 0.8,
      },
    },
  },
  connectorProfileUpdates: [{
    field: "employees",
    value: 20,
    sourceKind: "authoritative_api",
    provider: "unknown-b",
    asOf: "2026-07-01T00:00:00.000Z",
    axisCompleteness: "complete",
    confidence: 0.8,
  }],
});
assert.equal(unknownProviderTie.profilePreview.employees_count, 10);
assert.equal(unknownProviderTie.mergeDecisions[0]?.reason, "unknown_provider_tie");
assert.equal(unknownProviderTie.profilePreview.profile_evidence?.employees?.supplemental?.length, 1);

// 완전히 retained 된 update는 supplemental evidence만 기록하고, evidence와
// 다를 수 있는 legacy base confidence를 production처럼 그대로 둔다.
const retainedLegacyConfidence = buildDevFinalCompanyProfile({
  baseProfile: {
    revenue_krw: 1_000_000_000,
    confidence: { revenue: 0.7 },
    profile_evidence: {
      revenue: {
        sourceKind: "authoritative_api",
        provider: "nts",
        asOf: "2026-06-30T00:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 0.95,
      },
    },
  },
  connectorProfileUpdates: [{
    field: "revenue",
    value: 2_000_000_000,
    sourceKind: "self_declared",
    provider: "user",
    asOf: "2026-07-14T00:00:00.000Z",
    axisCompleteness: "partial",
    confidence: 0.6,
  }],
});
assert.equal(retainedLegacyConfidence.profilePreview.revenue_krw, 1_000_000_000);
assert.equal(retainedLegacyConfidence.profilePreview.confidence?.revenue, 0.7);
assert.equal(retainedLegacyConfidence.profilePreview.profile_evidence?.revenue?.confidence, 0.95);
assert.equal(retainedLegacyConfidence.mergeDecisions[0]?.valueDisposition, "retained");

// incoming primary는 기존처럼 incoming evidence confidence를 쓴다.
const incomingPrimaryConfidence = buildDevFinalCompanyProfile({
  baseProfile: {
    revenue_krw: 1_000_000_000,
    confidence: { revenue: 0.7 },
    profile_evidence: {
      revenue: {
        sourceKind: "self_declared",
        provider: "user",
        asOf: "2026-06-30T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.6,
      },
    },
  },
  connectorProfileUpdates: [{
    field: "revenue",
    value: 2_000_000_000,
    sourceKind: "authoritative_api",
    provider: "nts",
    asOf: "2026-07-14T00:00:00.000Z",
    axisCompleteness: "complete",
    confidence: 0.88,
  }],
});
assert.equal(incomingPrimaryConfidence.profilePreview.revenue_krw, 2_000_000_000);
assert.equal(incomingPrimaryConfidence.profilePreview.confidence?.revenue, 0.88);
assert.equal(incomingPrimaryConfidence.mergeDecisions[0]?.evidenceDisposition, "incoming_primary");

// Connector compound win은 production serviceData.ts처럼 shallow overlay하고,
// complete list만 소진적 빈 목록으로 교체한다.
const compoundAndExhaustive = buildDevFinalCompanyProfile({
  baseProfile: {
    certs: ["기존 인증"],
    financial_health: { equity_krw: 1_000_000_000 },
    confidence: { certification: 0.7, financial_health: 0.8 },
    list_completeness: { certification: "partial" },
    profile_evidence: {
      certification: {
        sourceKind: "self_declared",
        provider: "user",
        asOf: "2026-01-01T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.7,
      },
      financial_health: {
        sourceKind: "authoritative_api",
        provider: "fsc",
        asOf: "2025-12-31T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.8,
      },
    },
  },
  connectorProfileUpdates: [
    {
      field: "certification",
      value: [],
      sourceKind: "authoritative_api",
      provider: "startup_confirmation",
      asOf: "2026-07-01T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.95,
      mode: "replace",
    },
    {
      field: "financial_health",
      value: { capital_krw: 2_000_000_000, fiscal_year: "2025" },
      sourceKind: "authoritative_api",
      provider: "dart",
      asOf: "2026-07-01T00:00:00.000Z",
      axisCompleteness: "partial",
      confidence: 0.8,
    },
  ],
});
assert.deepEqual(compoundAndExhaustive.profilePreview.certs, []);
assert.equal(compoundAndExhaustive.profilePreview.list_completeness?.certification, "complete");
assert.deepEqual(compoundAndExhaustive.profilePreview.financial_health, {
  equity_krw: 1_000_000_000,
  capital_krw: 2_000_000_000,
  fiscal_year: "2025",
});
assert.equal(
  compoundAndExhaustive.fieldStates.find((state) => state.field === "certification")?.match_ready,
  true,
);

// other_conditions도 production serviceData.ts처럼 incoming primary를 shallow
// overlay해 기존 진단 키를 보존하고 동일 키만 incoming으로 갱신한다.
const otherOverlay = buildDevFinalCompanyProfile({
  baseProfile: {
    other_conditions: { existing_note: "기존 메모", shared_note: "기존 값" },
    confidence: { other: 0.5 },
    profile_evidence: {
      other: {
        sourceKind: "self_declared",
        provider: "user",
        asOf: "2026-01-01T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.5,
      },
    },
  },
  connectorProfileUpdates: [{
    field: "other",
    value: { new_note: "새 메모", shared_note: "새 값" },
    sourceKind: "authoritative_api",
    provider: "codef",
    asOf: "2026-07-14T00:00:00.000Z",
    axisCompleteness: "partial",
    confidence: 0.8,
  }],
});
assert.deepEqual(otherOverlay.profilePreview.other_conditions, {
  existing_note: "기존 메모",
  shared_note: "새 값",
  new_note: "새 메모",
});
assert.equal(otherOverlay.mergeDecisions[0]?.evidenceDisposition, "incoming_primary");

const partialPositiveWithQna = buildDevFinalCompanyProfile({
  baseProfile: authoritativeBase,
  connectorProfileUpdates: [],
  qna: {
    answers: {
      scenario: "registered_business",
      answers: [{ definitionId: id("certification"), value: ["자가인증"] }],
    },
    asOf: "2026-07-14T00:00:00.000Z",
  },
});
assert.deepEqual(partialPositiveWithQna.profilePreview.certs, ["공식인증", "자가인증"]);
assert.equal(partialPositiveWithQna.profilePreview.list_completeness?.certification, "partial");
assert.equal(partialPositiveWithQna.mergeDecisions[0]?.valueDisposition, "merged_supplemental");
assert.equal(
  partialPositiveWithQna.fieldStates.find((state) => state.field === "certification")?.match_ready,
  false,
  "positive partial union은 exhaustive absence 판정 준비로 과장하면 안 된다",
);

// Q&A supplemental merge는 계속 값을 union하고 current primary evidence의
// confidence를 반영한다. retained scalar의 legacy-confidence 예외와 구분한다.
const supplementalMergeConfidence = buildDevFinalCompanyProfile({
  baseProfile: {
    certs: ["공식인증"],
    confidence: { certification: 0.7 },
    list_completeness: { certification: "partial" },
    profile_evidence: {
      certification: {
        sourceKind: "public_registry",
        provider: "registry",
        asOf: "2026-06-30T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.95,
      },
    },
  },
  connectorProfileUpdates: [],
  qna: {
    answers: {
      scenario: "registered_business",
      answers: [{ definitionId: id("certification"), value: ["자가인증"] }],
    },
    asOf: "2026-07-14T00:00:00.000Z",
  },
});
assert.deepEqual(supplementalMergeConfidence.profilePreview.certs, ["공식인증", "자가인증"]);
assert.equal(supplementalMergeConfidence.profilePreview.confidence?.certification, 0.95);
assert.equal(supplementalMergeConfidence.mergeDecisions[0]?.valueDisposition, "merged_supplemental");

const noUpdateReplay = buildDevFinalCompanyProfile({
  baseProfile: authoritativeBase,
  connectorProfileUpdates: presentOnlyMiss,
  connectorSourcedDimensions: ["certification"],
  connectorNormalizedDimensions: ["certification"],
});
assert.deepEqual(noUpdateReplay.profilePreview, authoritativeBase);
assert.deepEqual(noUpdateReplay.mergeDecisions, []);

const failedQnaProof = buildDevFinalCompanyProfile({
  baseProfile: { confidence: {} },
  connectorProfileUpdates: [],
  qna: {
    answers: {
      scenario: "registered_business",
      answers: [{ definitionId: id("revenue"), value: "12억원" }],
    },
    asOf: "2026-07-14T00:00:00.000Z",
  },
});
assert.deepEqual(failedQnaProof.fieldStates.find((state) => state.field === "revenue"), {
  field: "revenue",
  sourced: true,
  normalized: false,
  match_ready: false,
  product_consumed: "pending",
});

const redacted = sanitizeDevServiceDataJson({
  safe: "kept",
  birthDate8: "19900101",
  phoneNo: "01012345678",
  representativeName: "홍길동",
  accessToken: "secret-token",
  trace: [{
    provider: "codef",
    status: "success",
    rawPayload: {
      provider: "codef",
      status: "ok",
      statusCode: 200,
      resultCode: "CF-00000",
      diagnostics: {
        safeFlag: true,
        birthDate8: "raw-birth",
        loginIdentity: "raw-login-birth",
        phoneNo: "raw-phone",
        resCeoNm: "raw-ceo",
        representativeName: "raw-representative",
        access_token: "raw-access-token",
        refresh_token: "raw-refresh-token",
        "액세스-토큰": "raw-korean-access-token",
        "리프레시_토큰": "raw-korean-refresh-token",
      },
    },
    canonicalPayload: { safe: true },
  }],
});
const redactedJson = JSON.stringify(redacted);
assert.equal(redactedJson.includes("19900101"), false);
assert.equal(redactedJson.includes("01012345678"), false);
assert.equal(redactedJson.includes("홍길동"), false);
assert.equal(redactedJson.includes("secret-token"), false);
assert.equal(redactedJson.includes("raw-birth"), false);
assert.equal(redactedJson.includes("raw-login-birth"), false);
assert.equal(redactedJson.includes("raw-phone"), false);
assert.equal(redactedJson.includes("raw-ceo"), false);
assert.equal(redactedJson.includes("raw-representative"), false);
assert.equal(redactedJson.includes("raw-access-token"), false);
assert.equal(redactedJson.includes("raw-refresh-token"), false);
assert.equal(redactedJson.includes("raw-korean-access-token"), false);
assert.equal(redactedJson.includes("raw-korean-refresh-token"), false);
assert.equal(redactedJson.includes("rawPayload"), true);
assert.deepEqual(redacted.trace[0]?.rawPayload, {
  provider: "codef",
  status: "ok",
  statusCode: 200,
  resultCode: "CF-00000",
  diagnostics: { safeFlag: true },
});
assert.equal(redacted.safe, "kept");

const normalizedSensitiveKeys = sanitizeDevServiceDataJson({
  rawPayload: {
    "LoGiN-IdEn_TiTy": "mixed-login",
    "ReS_CeO-Nm": "mixed-ceo",
    "PhOnE--No": "mixed-phone",
    "AcCeSs__ToKeN": "mixed-token",
    safe_status: "kept",
  },
});
assert.deepEqual(normalizedSensitiveKeys, { rawPayload: { safe_status: "kept" } });

const sensitivePreview = buildDevFinalCompanyProfile({
  baseProfile: {
    confidence: {},
    birthDate8: "19900101",
    phone: "01012345678",
    representativeName: "홍길동",
    rawPayload: { provider: "codef", status: "ok", birthDate8: "19900101" },
  } as CompanyProfile,
  connectorProfileUpdates: [{
    field: "other",
    value: { safe: "kept", accessToken: "secret-token", mobileNo: "01012345678" },
    sourceKind: "derived",
    provider: "codef",
    asOf: "2026-07-14T00:00:00.000Z",
    axisCompleteness: "partial",
    confidence: 0.5,
  }],
});
const sensitivePreviewJson = JSON.stringify(sensitivePreview);
assert.equal(sensitivePreviewJson.includes("19900101"), false);
assert.equal(sensitivePreviewJson.includes("01012345678"), false);
assert.equal(sensitivePreviewJson.includes("홍길동"), false);
assert.equal(sensitivePreviewJson.includes("secret-token"), false);
assert.equal(sensitivePreviewJson.includes("rawPayload"), true);
assert.equal(sensitivePreviewJson.includes('"provider":"codef"'), true);
assert.equal(sensitivePreviewJson.includes('"status":"ok"'), true);
assert.equal(sensitivePreview.profilePreview.other_conditions?.safe, "kept");

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
