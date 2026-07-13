import assert from "node:assert/strict";
import {
  matchGrantCriteria,
  PROCUREMENT_DEBARMENT_SOURCE,
  PROFILE_FIELD_SPEC_BY_KEY,
  questionDefinitionFor,
  updateCompanyProfileField,
  type FscCorpFinanceSummary,
  type NiceCreditSummary,
  type NiceIndicatorSummary,
  type RegistryMatch,
} from "@cunote/core";
import { measureAutofillCoverage } from "@cunote/core/autofill/coverage";
import { CRITERION_DIMENSIONS, type CompanyProfile, type GrantCriterion } from "@cunote/contracts";
import {
  buildCertificationProfileUpdates,
  buildBizAgeProfileUpdates,
  buildDisqualificationProfileUpdates,
  buildEmployeesProfileUpdates,
  buildFinancialHealthProfileUpdates,
  buildFounderAgeProfileUpdates,
  buildFounderTraitProfileUpdates,
  buildIndustryProfileUpdates,
  buildInsuredWorkforceProfileUpdates,
  buildInvestmentProfileUpdates,
  buildIpProfileUpdates,
  buildRegionProfileUpdates,
  buildRevenueProfileUpdates,
  buildTargetTypeProfileUpdates,
} from "./devServiceDataProfile";
import {
  addListCompletenessDiagnostics,
  applyRegistryMatches,
  attachConnectorProfileNormalization,
  buildFieldCoverage,
  buildQnaSchema,
  coalesceKiprisLookup,
  coalesceServiceDataLookup,
  coalesceStartupConfirmationLookup,
  collectConnectorProfileUpdates,
  mergeCertificationConnectorResult,
  mergeDartConnectorResults,
  profileFieldKeyForCoverageRow,
  setNiceCreditFields,
  setNiceIndicatorFields,
  setNumericField,
  setKiprisConnectorResults,
  writeDartFinancialResults,
  writeFscFinancialResults,
  type ConnectorResult,
  type ServiceDataLookupResult,
} from "./devServiceDataMonitor";

const qnaSchema = buildQnaSchema();
assert.equal(qnaSchema.definitionIds.industry, questionDefinitionFor("industry").id);
assert.equal(qnaSchema.definitionIds.financial_health, questionDefinitionFor("financial_health").id);

const codefIdentity = new Map<string, ConnectorResult>([
  [
    "founder_age",
    {
      ok: true,
      value: "35세",
      confidence: 0.9,
      source: "codef",
      sourceKind: "auth_supplied",
      asOf: "2026-07-12T00:00:00.000Z",
    },
  ],
  [
    "region",
    {
      ok: true,
      value: "서울",
      confidence: 0.95,
      source: "codef",
      sourceKind: "authoritative_api",
      asOf: "2026-07-12T00:00:00.000Z",
    },
  ],
]);

const codefRows = buildFieldCoverage({
  subject: "corporation",
  profile: null,
  fields: [],
  originBySource: new Map(),
  connectorResults: codefIdentity,
});
for (const row of codefRows) {
  const profileFieldKey = profileFieldKeyForCoverageRow(row.key);
  assert.ok(
    profileFieldKey !== null && PROFILE_FIELD_SPEC_BY_KEY.has(profileFieldKey),
    `${row.key} dev coverage 행은 core field spec을 참조해야 한다`,
  );
}
assert.deepEqual(
  codefRows
    .filter((row) => row.parentKey === null && row.dimension !== null)
    .map((row) => row.dimension),
  [...CRITERION_DIMENSIONS],
  "dev criterion 부모 행은 contracts dimension과 같은 순서로 정확히 하나씩 유지해야 한다",
);
for (const key of [
  "industry.industry_codes",
  "industry.list_completeness",
  "prior_award.records",
  "prior_award.known_programs",
  "prior_award.known_program_types",
  "ip.right_kinds",
  "ip.right_statuses",
  "ip.list_completeness",
  "target_type.legal_form",
  "target_type.applicant_tags",
  "financial_health.interest_coverage_ratio",
  "financial_health.capital_krw",
  "financial_health.fiscal_year",
  "insured_workforce.months_since_last_layoff",
] as const) {
  assert.equal(profileFieldKeyForCoverageRow(key), key);
}
const founderAge = codefRows.find((row) => row.key === "founder_age");
assert.equal(founderAge?.status, "cache");
assert.equal(founderAge?.sourceKind, "auth_supplied");
assert.equal(founderAge?.axisCompleteness, "complete");
assert.equal(
  codefRows.find((row) => row.key === "target_type")?.axisCompleteness,
  "partial",
  "사업자번호 파생 법적 형태만으로 신청 주체 태그까지 complete 처리하면 안 된다",
);
assert.equal(codefRows.find((row) => row.key === "target_type.legal_form")?.status, "live");

const codefMetrics = measureAutofillCoverage(codefRows);
assert.equal(codefMetrics.authoritative_axis_coverage.numerator, 1);
assert.equal(
  codefMetrics.total_answered_coverage.numerator,
  2,
  "region + 인증 입력 age만 complete이며 법적 형태-only target_type은 answered complete로 세지 않는다",
);

const registryChild = new Map<string, ConnectorResult>([
  [
    "sanction.participation_restricted",
    {
      ok: true,
      value: "참여제한 있음",
      confidence: 0.9,
      source: "registry",
      sourceKind: "public_registry",
      axisCompleteness: "partial",
    },
  ],
]);
const registryRows = buildFieldCoverage({
  subject: "corporation",
  profile: null,
  fields: [],
  originBySource: new Map(),
  connectorResults: registryChild,
});
assert.equal(
  registryRows.find((row) => row.key === "sanction.participation_restricted")?.axisCompleteness,
  "partial",
);
assert.equal(
  measureAutofillCoverage(registryRows).authoritative_axis_coverage.numerator,
  0,
  "하위 제재 플래그 하나는 sanction 부모축 전체 확정으로 집계하면 안 된다",
);

const connectorOutcomes = new Map<string, ConnectorResult>([
  [
    "employees",
    {
      ok: false,
      empty: true,
      reason: "고용보험 가입 사업장 없음",
      source: "kcomwel",
      sourceKind: "authoritative_api",
      asOf: "2026-07-12T01:00:00.000Z",
    },
  ],
  [
    "financial_health.debt_ratio_pct",
    {
      ok: false,
      skipped: true,
      reason: "법인등록번호 없음",
      source: "fsc",
      sourceKind: "authoritative_api",
    },
  ],
  [
    "financial_health.total_assets_krw",
    {
      ok: false,
      reason: "HTTP 500",
      source: "fsc",
      sourceKind: "authoritative_api",
      asOf: "2026-07-12T01:00:00.000Z",
    },
  ],
]);
const outcomeRows = buildFieldCoverage({
  subject: "corporation",
  profile: null,
  fields: [],
  originBySource: new Map(),
  connectorResults: connectorOutcomes,
});
const emptyEmployees = outcomeRows.find((row) => row.key === "employees");
assert.equal(emptyEmployees?.status, "pending", "정상 빈값은 API 실패로 집계하면 안 된다");
assert.equal(emptyEmployees?.connectorOutcome, "empty");
assert.equal(emptyEmployees?.source, "kcomwel");
assert.equal(emptyEmployees?.asOf, "2026-07-12T01:00:00.000Z");
assert.equal(
  outcomeRows.find((row) => row.key === "financial_health.debt_ratio_pct")?.connectorOutcome,
  "prerequisite",
);
assert.equal(
  outcomeRows.find((row) => row.key === "financial_health.total_assets_krw")?.status,
  "failed",
);
assert.equal(
  outcomeRows.find((row) => row.key === "financial_health.total_assets_krw")?.connectorOutcome,
  "error",
);

const displayValueWithNormalizationFailure = attachConnectorProfileNormalization(
  {
    ok: true,
    value: "12억원",
    confidence: 0.9,
    source: "dart",
    sourceKind: "authoritative_api",
    asOf: "2026-06-30",
  },
  buildRevenueProfileUpdates("12억원", {
    sourceKind: "authoritative_api",
    provider: "dart",
    asOf: "2026-06-30",
    confidence: 0.9,
    axisCompleteness: "complete",
  }),
);
assert.equal(displayValueWithNormalizationFailure.ok, true, "typed 변환 실패가 provider 성공을 실패로 바꾸면 안 된다");
assert.equal(displayValueWithNormalizationFailure.value, "12억원", "기존 표시값을 보존해야 한다");
assert.equal(displayValueWithNormalizationFailure.normalizationFailure?.code, "normalization_failed");
assert.equal(displayValueWithNormalizationFailure.profileUpdates, undefined);

const displayValueWithProfileUpdate = attachConnectorProfileNormalization(
  {
    ok: true,
    value: "12억원",
    confidence: 0.9,
    source: "dart",
    sourceKind: "authoritative_api",
    asOf: "2026-06-30",
  },
  buildRevenueProfileUpdates(1_200_000_000, {
    sourceKind: "authoritative_api",
    provider: "dart",
    asOf: "2026-06-30",
    confidence: 0.9,
    axisCompleteness: "complete",
  }),
);
assert.equal(displayValueWithProfileUpdate.value, "12억원");
assert.equal(displayValueWithProfileUpdate.profileUpdates?.[0]?.value, 1_200_000_000);

const fscNumericResults = new Map<string, ConnectorResult>();
setNumericField(fscNumericResults, "revenue", "12억원", 0.85, " (2025)", "2025-12-31", 1_200_000_000);
setNumericField(
  fscNumericResults,
  "financial_health.debt_ratio_pct",
  "120%",
  0.85,
  " (2025)",
  "2025-12-31",
);
assert.equal(fscNumericResults.get("revenue")?.axisCompleteness, "complete");
assert.equal(
  fscNumericResults.get("financial_health.debt_ratio_pct")?.axisCompleteness,
  undefined,
  "FSC 하위 진단행은 부모 revenue의 complete를 상속하면 안 된다",
);
const fscNumericRows = buildFieldCoverage({
  subject: "corporation",
  profile: null,
  fields: [],
  originBySource: new Map(),
  connectorResults: fscNumericResults,
});
assert.equal(
  fscNumericRows.find((row) => row.key === "financial_health.debt_ratio_pct")?.axisCompleteness,
  "partial",
  "FSC financial_health 하위 진단행은 기존 default partial 표시를 유지해야 한다",
);

const registryCertificationUpdates = buildCertificationProfileUpdates(
  ["벤처기업"],
  {
    sourceKind: "public_registry",
    provider: "registry",
    asOf: "2025-12-30",
    confidence: 0.55,
    axisCompleteness: "partial",
  },
);
assert.equal(registryCertificationUpdates.ok, true);
const startupCertificationUpdates = buildCertificationProfileUpdates(
  ["창업기업확인서"],
  {
    sourceKind: "authoritative_api",
    provider: "startup_confirmation",
    asOf: "2025-12-31",
    confidence: 0.95,
    axisCompleteness: "partial",
  },
);
assert.equal(startupCertificationUpdates.ok, true);
const existingNormalizationFailure = {
  code: "normalization_failed" as const,
  field: "certification" as const,
  message: "registry normalization failed",
};
const startupNormalizationFailure = {
  code: "normalization_failed" as const,
  field: "certification" as const,
  message: "startup normalization failed",
};
const certificationResults = new Map<string, ConnectorResult>([
  [
    "certification",
    {
      ok: true,
      value: "벤처기업",
      confidence: 0.55,
      source: "registry",
      sourceKind: "public_registry",
      asOf: "2025-12-30",
      axisCompleteness: "partial",
      profileUpdates: registryCertificationUpdates.ok
        ? registryCertificationUpdates.profileUpdates
        : [],
      normalizationFailure: existingNormalizationFailure,
    },
  ],
]);
mergeCertificationConnectorResult(certificationResults, {
  ok: true,
  value: "창업기업확인서",
  confidence: 0.95,
  source: "kised",
  sourceKind: "authoritative_api",
  asOf: "2025-12-31",
  axisCompleteness: "partial",
  profileUpdates: startupCertificationUpdates.ok
    ? startupCertificationUpdates.profileUpdates
    : [],
});
const certificationWithExistingFailure = certificationResults.get("certification");
assert.equal(certificationWithExistingFailure?.ok, true);
assert.equal(certificationWithExistingFailure?.value, "벤처기업, 창업기업확인서");
assert.equal(certificationWithExistingFailure?.confidence, 0.95);
assert.equal(certificationWithExistingFailure?.source, "kised");
assert.equal(certificationWithExistingFailure?.sourceKind, "authoritative_api");
assert.equal(certificationWithExistingFailure?.asOf, "2025-12-31");
assert.equal(certificationWithExistingFailure?.profileUpdates?.length, 2);
assert.deepEqual(
  certificationWithExistingFailure?.normalizationFailure,
  existingNormalizationFailure,
  "startup 진단이 없으면 registry normalization failure를 보존해야 한다",
);
mergeCertificationConnectorResult(certificationResults, {
  ok: true,
  value: "창업기업확인서",
  confidence: 0.95,
  source: "kised",
  sourceKind: "authoritative_api",
  asOf: "2026-01-01",
  axisCompleteness: "partial",
  normalizationFailure: startupNormalizationFailure,
});
assert.deepEqual(
  certificationResults.get("certification")?.normalizationFailure,
  startupNormalizationFailure,
  "startup normalization failure가 registry 진단보다 우선해야 한다",
);

const typedMetadata = {
  sourceKind: "authoritative_api" as const,
  provider: "g2b-test",
  asOf: "2026-07-14T00:00:00.000Z",
  confidence: 0.9,
  axisCompleteness: "partial" as const,
};
const typedPathCases = [
  ["region", buildRegionProfileUpdates({ code: "11", label: "서울" }, { ...typedMetadata, axisCompleteness: "complete" })],
  ["biz_age", buildBizAgeProfileUpdates(24, { ...typedMetadata, axisCompleteness: "complete" })],
  ["industry", buildIndustryProfileUpdates({ labels: ["소프트웨어"], codes: ["62010"] }, typedMetadata)],
  ["revenue", buildRevenueProfileUpdates(1_000_000_000, { ...typedMetadata, axisCompleteness: "complete" })],
  ["employees", buildEmployeesProfileUpdates(10, { ...typedMetadata, axisCompleteness: "complete" })],
  ["founder_age", buildFounderAgeProfileUpdates(35, { ...typedMetadata, axisCompleteness: "complete" })],
  ["founder_trait", buildFounderTraitProfileUpdates(["여성"], typedMetadata)],
  ["certification", buildCertificationProfileUpdates(["창업기업확인서"], typedMetadata)],
  ["ip", buildIpProfileUpdates(["특허·실용신안"], typedMetadata)],
  ["target_type", buildTargetTypeProfileUpdates(["법인"], typedMetadata)],
  ["tax_compliance", buildDisqualificationProfileUpdates(
    "tax_compliance",
    { flags: [], known_flags: ["national_tax_delinquent"], exceptions: [] },
    typedMetadata,
  )],
  ["credit_status", buildDisqualificationProfileUpdates(
    "credit_status",
    { flags: ["credit_delinquency"], known_flags: ["credit_delinquency"], exceptions: [] },
    typedMetadata,
  )],
  ["sanction", buildDisqualificationProfileUpdates(
    "sanction",
    { flags: [], known_flags: ["participation_restricted"], exceptions: [] },
    typedMetadata,
  )],
  ["financial_health", buildFinancialHealthProfileUpdates(
    { equity_krw: 1_000_000_000, capital_krw: 2_000_000_000, fiscal_year: "2025" },
    typedMetadata,
  )],
  ["insured_workforce", buildInsuredWorkforceProfileUpdates(
    { employment_insurance_active: true, insured_count: 10 },
    typedMetadata,
  )],
  ["investment", buildInvestmentProfileUpdates({ tips_backed: true }, typedMetadata)],
] as const;
const typedPathResults = new Map<string, ConnectorResult>();
for (const [key, normalization] of typedPathCases) {
  typedPathResults.set(key, attachConnectorProfileNormalization({
    ok: true,
    value: `${key} value`,
    source: key === "sanction" || key === "investment" ? "registry" : "codef",
    sourceKind: key === "sanction" || key === "investment" ? "public_registry" : "authoritative_api",
    confidence: 0.9,
    axisCompleteness: "partial",
  }, normalization));
}
for (const childKey of [
  "industry.industry_codes",
  "ip.right_kinds",
  "ip.right_statuses",
  "target_type.legal_form",
  "financial_health.capital_krw",
  "financial_health.fiscal_year",
  "insured_workforce.employment_insurance_active",
  "sanction.participation_restricted",
  "investment.tips_backed",
]) {
  typedPathResults.set(childKey, {
    ok: true,
    value: `${childKey} diagnostic`,
    source: "codef",
    sourceKind: "authoritative_api",
    axisCompleteness: "partial",
  });
}
addListCompletenessDiagnostics(typedPathResults);
for (const dimension of ["industry", "founder_trait", "certification", "ip", "target_type"] as const) {
  assert.equal(
    typedPathResults.get(`${dimension}.list_completeness`)?.value,
    "partial",
    `${dimension} connector typed update는 목록 completeness 진단을 함께 내야 한다`,
  );
}
const typedPathAudit = collectConnectorProfileUpdates(typedPathResults);
assert.deepEqual(
  typedPathAudit.audit.missingTypedUpdateKeys,
  [],
  "현재 matcher 값을 만드는 connector 부모/진단 하위행은 같은 축 typed update로 수렴해야 한다",
);
assert.deepEqual(
  new Set(typedPathAudit.audit.typedDimensions),
  new Set(typedPathCases.map(([key]) => key)),
);

const kiprisResults = new Map<string, ConnectorResult>();
setKiprisConnectorResults(
  kiprisResults,
  {
    applicantNumber: "1234",
    applicantName: "테스트",
    corporationNumber: "1101111234567",
    businessRegistrationNumber: "3948603207",
  },
  {
    patentUtility: {
      kind: "patent_utility",
      totalCount: 2,
      appliedCount: 2,
      fetchedCount: 2,
      publishedCount: 1,
      registeredCount: 1,
      extinguishedCount: 0,
      truncated: false,
    },
    design: {
      kind: "design",
      totalCount: 0,
      appliedCount: 0,
      fetchedCount: 0,
      publishedCount: 0,
      registeredCount: 0,
      extinguishedCount: 0,
      truncated: false,
    },
    trademark: {
      kind: "trademark",
      totalCount: 1,
      appliedCount: 1,
      fetchedCount: 1,
      publishedCount: 0,
      registeredCount: 1,
      extinguishedCount: 0,
      truncated: false,
    },
    totalCount: 3,
    truncated: false,
  },
  "live",
  "2026-07-14T00:00:00.000Z",
);
assert.deepEqual(kiprisResults.get("ip")?.profileUpdates?.[0]?.value, ["특허·실용신안", "상표"]);
assert.equal(kiprisResults.get("ip")?.axisCompleteness, "partial");
assert.equal(kiprisResults.get("ip")?.profileUpdates?.[0]?.mode, "merge");
assert.equal(kiprisResults.get("ip.right_kinds")?.value, "특허·실용신안, 상표");
assert.match(kiprisResults.get("ip.right_statuses")?.value ?? "", /등록 2/);
const kiprisProfile = (kiprisResults.get("ip")?.profileUpdates ?? []).reduce<CompanyProfile>(
  (profile, update) => updateCompanyProfileField(profile, update),
  { confidence: {} },
);
const ipTypeVocabularyCriterion: GrantCriterion = {
  dimension: "ip",
  operator: "in",
  value: { types: ["특허"] },
  kind: "required",
  confidence: 1,
};
assert.equal(
  matchGrantCriteria([ipTypeVocabularyCriterion], kiprisProfile).rule_trace[0]?.result,
  "unknown",
  "KIPRIS 종류와 공고 vocabulary가 다르면 exact 비절단이어도 false fail이 아니어야 한다",
);
const zeroRightSummary = (kind: "patent_utility" | "design" | "trademark") => ({
  kind,
  totalCount: 0,
  appliedCount: 0,
  fetchedCount: 0,
  publishedCount: 0,
  registeredCount: 0,
  extinguishedCount: 0,
  truncated: false,
});
const zeroRightsKipris = new Map<string, ConnectorResult>();
setKiprisConnectorResults(
  zeroRightsKipris,
  {
    applicantNumber: "1234",
    applicantName: "테스트",
    corporationNumber: "1101111234567",
    businessRegistrationNumber: "3948603207",
  },
  {
    patentUtility: zeroRightSummary("patent_utility"),
    design: zeroRightSummary("design"),
    trademark: zeroRightSummary("trademark"),
    totalCount: 0,
    truncated: false,
  },
  "live",
  "2026-07-14T00:00:00.000Z",
);
assert.equal(zeroRightsKipris.get("ip")?.axisCompleteness, "partial");
assert.equal(zeroRightsKipris.get("ip")?.profileUpdates, undefined);
const ipExistsCriterion: GrantCriterion = {
  dimension: "ip",
  operator: "exists",
  value: {},
  kind: "required",
  confidence: 1,
};
assert.equal(
  matchGrantCriteria([ipExistsCriterion], { confidence: {} }).rule_trace[0]?.result,
  "unknown",
  "KIPRIS exact zero-rights는 IP 미보유 false fail로 굳히면 안 된다",
);
const kiprisMiss = new Map<string, ConnectorResult>();
setKiprisConnectorResults(kiprisMiss, null, null, "live", "2026-07-14T00:00:00.000Z");
assert.equal(kiprisMiss.get("ip")?.empty, true);
assert.equal(kiprisMiss.get("ip")?.profileUpdates, undefined, "KIPRIS miss는 IP 부재 update가 아니다");
assert.equal(kiprisMiss.has("ip.right_kinds"), false);
const truncatedKipris = new Map<string, ConnectorResult>();
const completeRights = {
  patentUtility: {
    kind: "patent_utility" as const,
    totalCount: 501,
    appliedCount: 500,
    fetchedCount: 500,
    publishedCount: 200,
    registeredCount: 200,
    extinguishedCount: 100,
    truncated: true,
  },
  design: {
    kind: "design" as const,
    totalCount: 0,
    appliedCount: 0,
    fetchedCount: 0,
    publishedCount: 0,
    registeredCount: 0,
    extinguishedCount: 0,
    truncated: false,
  },
  trademark: {
    kind: "trademark" as const,
    totalCount: 0,
    appliedCount: 0,
    fetchedCount: 0,
    publishedCount: 0,
    registeredCount: 0,
    extinguishedCount: 0,
    truncated: false,
  },
  totalCount: 501,
  truncated: true,
};
setKiprisConnectorResults(
  truncatedKipris,
  {
    applicantNumber: "1234",
    applicantName: "테스트",
    corporationNumber: "1101111234567",
    businessRegistrationNumber: "3948603207",
  },
  completeRights,
  "live",
  "2026-07-14T00:00:00.000Z",
);
assert.equal(truncatedKipris.get("ip")?.axisCompleteness, "partial");

const dartTypedResults = new Map<string, ConnectorResult>();
writeDartFinancialResults(dartTypedResults, {
  corpCode: "00126380",
  businessYear: "2025",
  reportCode: "11011",
  statementType: "CFS",
  statementName: "연결재무제표",
  receptionNo: "20260331000001",
  periodEnd: "2025-12-31",
  revenue: 10_000_000_000,
  totalAssets: 20_000_000_000,
  totalLiabilities: 12_000_000_000,
  totalEquity: 8_000_000_000,
  currency: "KRW",
}, "사업보고서", "cache");
assert.equal(dartTypedResults.get("revenue")?.profileUpdates?.[0]?.provider, "dart");
assert.equal(dartTypedResults.get("financial_health")?.profileUpdates?.[0]?.provider, "dart");
assert.equal(dartTypedResults.get("financial_health")?.profileUpdates?.[0]?.axisCompleteness, "partial");
assert.equal(
  (dartTypedResults.get("financial_health")?.profileUpdates?.[0]?.value as { fiscal_year?: string }).fiscal_year,
  "2025",
);
assert.match(
  dartTypedResults.get("financial_health.impairment")?.value ?? "",
  /자본금 미제공/,
  "자본금 없는 positive equity를 정상으로 단정하면 안 된다",
);

const dartNegativeEquityResults = new Map<string, ConnectorResult>();
writeDartFinancialResults(dartNegativeEquityResults, {
  corpCode: "00126380",
  businessYear: "2025",
  reportCode: "11011",
  statementType: "CFS",
  statementName: "연결재무제표",
  receptionNo: "20260331000002",
  periodEnd: "2025-12-31",
  revenue: 10_000_000_000,
  totalAssets: 7_000_000_000,
  totalLiabilities: 12_000_000_000,
  totalEquity: -5_000_000_000,
  currency: "KRW",
}, "사업보고서", "cache");
const dartNegativeFinancial = dartNegativeEquityResults.get("financial_health");
const dartNegativeUpdate = dartNegativeFinancial?.profileUpdates?.find((candidate) => candidate.provider === "dart");
assert.ok(dartNegativeUpdate, "DART 음수 equity에서도 financial_health typed update가 생존해야 한다");
const dartNegativeValue = dartNegativeUpdate.value as Record<string, unknown>;
assert.equal(dartNegativeValue.impairment, "full");
assert.equal(dartNegativeValue.equity_krw, -5_000_000_000);
assert.equal(dartNegativeValue.fiscal_year, "2025");
assert.equal(dartNegativeValue.debt_ratio_pct, undefined, "음수 파생 부채비율은 typed value에 포함하지 않는다");
assert.equal(dartNegativeUpdate.provider, "dart");
assert.equal(dartNegativeUpdate.sourceKind, "authoritative_api");
assert.equal(dartNegativeUpdate.asOf, "2025-12-31");
assert.equal(dartNegativeUpdate.confidence, 0.9);
assert.equal(dartNegativeUpdate.axisCompleteness, "partial");
assert.equal(dartNegativeFinancial?.normalizationFailure, undefined);
assert.equal(
  dartNegativeEquityResults.get("financial_health.debt_ratio_pct")?.value,
  "-240%",
  "DART 음수 파생 비율의 표시용 진단값은 보존해야 한다",
);

const fscBase: FscCorpFinanceSummary = {
  bizYear: "2025",
  basDt: "20251231",
  fnclDcdNm: "연결",
  saleAmt: 10_000_000_000,
  operatingProfit: 1_000_000_000,
  netIncome: 800_000_000,
  totalAssets: 20_000_000_000,
  totalLiabilities: 12_000_000_000,
  totalEquity: 8_000_000_000,
  capital: 2_000_000_000,
  debtRatioPct: 150,
  impaired: false,
  currency: "KRW",
};
const fscImpairmentCases = [
  { equity: 3_000_000_000, capital: 2_000_000_000, expected: "none" },
  { equity: 1_000_000_000, capital: 2_000_000_000, expected: "partial" },
  { equity: -1, capital: 2_000_000_000, expected: "full" },
  { equity: 1_000_000_000, capital: null, expected: null },
] as const;
for (const testCase of fscImpairmentCases) {
  const results = new Map<string, ConnectorResult>();
  writeFscFinancialResults(results, {
    ...fscBase,
    totalEquity: testCase.equity,
    capital: testCase.capital,
    impaired: testCase.equity <= 0,
  }, "2026-07-14T00:00:00.000Z");
  const update = results.get("financial_health")?.profileUpdates?.find((candidate) => candidate.provider === "fsc");
  assert.ok(update, "FSC 실제 기록 경로는 financial_health typed update를 방출해야 한다");
  const value = update.value as Record<string, unknown>;
  assert.equal(value.fiscal_year, "2025");
  assert.equal(value.capital_krw, testCase.capital ?? undefined);
  assert.equal(value.impairment, testCase.expected ?? undefined);
  assert.equal(update.axisCompleteness, "partial");
}

const fscMissingEquityResults = new Map<string, ConnectorResult>();
writeFscFinancialResults(fscMissingEquityResults, {
  ...fscBase,
  totalEquity: null,
}, "2026-07-14T00:00:00.000Z");
assert.match(
  fscMissingEquityResults.get("financial_health.impairment")?.value ?? "",
  /자본총계 미제공/,
  "FSC equity 결측은 자본금이 아니라 자본총계 미제공으로 표시해야 한다",
);
const fscMissingEquityValue = fscMissingEquityResults.get("financial_health")?.profileUpdates?.[0]
  ?.value as Record<string, unknown>;
assert.equal(fscMissingEquityValue.equity_krw, undefined);
assert.equal(fscMissingEquityValue.capital_krw, 2_000_000_000);
assert.equal(fscMissingEquityValue.impairment, undefined, "FSC 표시 문구 변경이 typed 판정을 만들면 안 된다");

const fscMissingCapitalResults = new Map<string, ConnectorResult>();
writeFscFinancialResults(fscMissingCapitalResults, {
  ...fscBase,
  capital: null,
}, "2026-07-14T00:00:00.000Z");
assert.match(
  fscMissingCapitalResults.get("financial_health.impairment")?.value ?? "",
  /자본금 미제공/,
  "FSC equity가 있고 capital만 결측이면 자본금 미제공으로 표시해야 한다",
);
const fscMissingCapitalValue = fscMissingCapitalResults.get("financial_health")?.profileUpdates?.[0]
  ?.value as Record<string, unknown>;
assert.equal(fscMissingCapitalValue.equity_krw, 8_000_000_000);
assert.equal(fscMissingCapitalValue.capital_krw, undefined);
assert.equal(fscMissingCapitalValue.impairment, undefined, "FSC capital 결측 typed semantics를 유지해야 한다");

const fscNegativeDebtRatioResults = new Map<string, ConnectorResult>();
writeFscFinancialResults(fscNegativeDebtRatioResults, {
  ...fscBase,
  totalEquity: -5_000_000_000,
  debtRatioPct: -240,
  impaired: true,
}, "2026-07-14T00:00:00.000Z");
const fscNegativeFinancial = fscNegativeDebtRatioResults.get("financial_health");
const fscNegativeUpdate = fscNegativeFinancial?.profileUpdates?.find((candidate) => candidate.provider === "fsc");
assert.ok(fscNegativeUpdate, "FSC 음수 부채비율에서도 financial_health typed update가 생존해야 한다");
const fscNegativeValue = fscNegativeUpdate.value as Record<string, unknown>;
assert.equal(fscNegativeValue.impairment, "full");
assert.equal(fscNegativeValue.equity_krw, -5_000_000_000);
assert.equal(fscNegativeValue.fiscal_year, "2025");
assert.equal(fscNegativeValue.debt_ratio_pct, undefined, "FSC 음수 부채비율은 typed value에 포함하지 않는다");
assert.equal(fscNegativeUpdate.provider, "fsc");
assert.equal(fscNegativeUpdate.sourceKind, "authoritative_api");
assert.equal(fscNegativeUpdate.asOf, "2025-12-31");
assert.equal(fscNegativeUpdate.confidence, 0.85);
assert.equal(fscNegativeUpdate.axisCompleteness, "partial");
assert.equal(fscNegativeFinancial?.normalizationFailure, undefined);
assert.equal(
  fscNegativeDebtRatioResults.get("financial_health.debt_ratio_pct")?.value,
  "-240% (2025)",
  "FSC 음수 부채비율의 표시용 진단값은 보존해야 한다",
);

const fscForDartMerge = new Map<string, ConnectorResult>();
writeFscFinancialResults(fscForDartMerge, {
  ...fscBase,
  totalEquity: 800_000_000,
  capital: 2_000_000_000,
}, "2026-07-14T00:00:00.000Z");
mergeDartConnectorResults(fscForDartMerge, dartTypedResults);
const mergedFinancial = fscForDartMerge.get("financial_health");
assert.equal(mergedFinancial?.source, "fsc", "FSC 판정 표시를 DART 자본금 미제공 진단으로 덮지 않는다");
assert.deepEqual(
  mergedFinancial?.profileUpdates?.map((update) => update.provider),
  ["dart", "fsc"],
  "DART/FSC observations는 provider/asOf가 다른 두 update로 결정론적으로 보존해야 한다",
);
const retainedFscValue = mergedFinancial?.profileUpdates?.find((update) => update.provider === "fsc")?.value as
  | Record<string, unknown>
  | undefined;
assert.equal(retainedFscValue?.capital_krw, 2_000_000_000);
assert.equal(retainedFscValue?.impairment, "partial");
assert.equal(fscForDartMerge.get("financial_health.impairment")?.source, "fsc");
assert.match(fscForDartMerge.get("financial_health.impairment")?.value ?? "", /부분자본잠식/);

const niceIndicatorResults = new Map<string, ConnectorResult>();
const niceIndicator: NiceIndicatorSummary = {
  bizYear: "2025",
  stacDate: "20251231",
  revenueWon: 9_000_000_000,
  totalAssetsWon: 12_000_000_000,
  totalEquityWon: 4_000_000_000,
  totalLiabilitiesWon: 8_000_000_000,
  operatingProfitWon: 500_000_000,
  netIncomeWon: 300_000_000,
  debtRatioPct: 200,
  impaired: false,
  auditOpinion: "적정",
};
setNiceIndicatorFields(niceIndicatorResults, niceIndicator);
const niceFinancialUpdate = niceIndicatorResults.get("financial_health")?.profileUpdates?.[0];
assert.equal(niceFinancialUpdate?.provider, "nice");
assert.equal((niceFinancialUpdate?.value as Record<string, unknown>).fiscal_year, "2025");
assert.equal((niceFinancialUpdate?.value as Record<string, unknown>).equity_krw, 4_000_000_000);
assert.equal((niceFinancialUpdate?.value as Record<string, unknown>).impairment, undefined);
assert.match(
  niceIndicatorResults.get("financial_health.impairment")?.value ?? "",
  /자본금 미제공/,
  "NICE equity가 있고 capital이 없으면 자본금 미제공으로 표시해야 한다",
);

const niceMissingEquityResults = new Map<string, ConnectorResult>();
setNiceIndicatorFields(niceMissingEquityResults, {
  ...niceIndicator,
  totalEquityWon: null,
  debtRatioPct: null,
});
assert.match(
  niceMissingEquityResults.get("financial_health.impairment")?.value ?? "",
  /자본총계 미제공/,
  "NICE equity 결측은 자본금이 아니라 자본총계 미제공으로 표시해야 한다",
);
const niceMissingEquityValue = niceMissingEquityResults.get("financial_health")?.profileUpdates?.[0]
  ?.value as Record<string, unknown>;
assert.equal(niceMissingEquityValue.equity_krw, undefined);
assert.equal(niceMissingEquityValue.impairment, undefined, "NICE 표시 문구 변경이 typed 판정을 만들면 안 된다");

const niceCreditResults = new Map<string, ConnectorResult>();
const niceCredit: NiceCreditSummary = {
  negative: {
    ok: true,
    data: {
      counts: { bb: 1, fd: 0, pb: 2, sb: 0, totalOcc: 3 },
      details: [],
      listCount: 3,
    },
  },
  workout: { ok: true, data: { count: 0, items: [] } },
  summary: { ok: false, data: null, notProvisioned: true },
};
setNiceCreditFields(niceCreditResults, niceCredit);
const niceCreditValue = niceCreditResults.get("credit_status")?.profileUpdates?.[0]?.value as Record<string, unknown>;
assert.deepEqual(niceCreditValue.flags, ["credit_delinquency", "loan_default"]);
assert.deepEqual(niceCreditValue.known_flags, [
  "credit_delinquency",
  "loan_default",
  "financial_misconduct",
  "rehabilitation_in_progress",
  "court_receivership",
]);
assert.equal(
  niceCreditResults.get("tax_compliance")?.profileUpdates,
  undefined,
  "양수 PB 미분리 신호는 국세/지방세를 모두 held/known으로 typed 승격하면 안 된다",
);
assert.match(
  niceCreditResults.get("tax_compliance.national_tax_delinquent")?.value ?? "",
  /공공정보 2건\(국세\/지방세 미분리\)/,
  "양수 PB 진단 표시는 보존해야 한다",
);
const niceCreditProfile = collectConnectorProfileUpdates(niceCreditResults).profileUpdates.reduce<CompanyProfile>(
  (profile, update) => updateCompanyProfileField(profile, update),
  { confidence: {} },
);
const nationalTaxOnlyCriterion: GrantCriterion = {
  dimension: "tax_compliance",
  operator: "in",
  value: { flags: ["national_tax_delinquent"] },
  kind: "exclusion",
  confidence: 1,
};
const ambiguousTaxMatch = matchGrantCriteria([nationalTaxOnlyCriterion], niceCreditProfile);
assert.equal(ambiguousTaxMatch.rule_trace[0]?.result, "unknown");
assert.equal(ambiguousTaxMatch.eligibility, "conditional", "양수 PB 미분리 신호로 false pass를 만들면 안 된다");
const exactCreditCriterion: GrantCriterion = {
  dimension: "credit_status",
  operator: "in",
  value: { flags: ["credit_delinquency"] },
  kind: "exclusion",
  confidence: 1,
};
assert.equal(
  matchGrantCriteria([exactCreditCriterion], niceCreditProfile).eligibility,
  "ineligible",
  "분리된 OCCD03 BB 양수 신호의 held/known semantics는 유지해야 한다",
);

const niceWorkoutAmbiguousResults = new Map<string, ConnectorResult>();
setNiceCreditFields(niceWorkoutAmbiguousResults, {
  negative: {
    ok: true,
    data: {
      counts: { bb: 0, fd: 0, pb: 0, sb: 0, totalOcc: 0 },
      details: [],
      listCount: 0,
    },
  },
  workout: { ok: true, data: { count: 1, items: [] } },
  summary: { ok: false, data: null, notProvisioned: true },
});
const workoutCreditValue = niceWorkoutAmbiguousResults.get("credit_status")?.profileUpdates?.[0]
  ?.value as Record<string, unknown>;
assert.deepEqual(workoutCreditValue.flags, []);
assert.deepEqual(
  workoutCreditValue.known_flags,
  ["credit_delinquency", "loan_default", "financial_misconduct"],
  "양수 OCCD06 미분리 신호는 회생/법정관리 어느 쪽도 known으로 승격하면 안 된다",
);
assert.match(
  niceWorkoutAmbiguousResults.get("credit_status.rehabilitation_in_progress")?.value ?? "",
  /법정관리\/워크아웃 1건/,
  "양수 OCCD06 진단 표시는 보존해야 한다",
);
const zeroTaxValue = niceWorkoutAmbiguousResults.get("tax_compliance")?.profileUpdates?.[0]
  ?.value as Record<string, unknown>;
assert.deepEqual(zeroTaxValue.flags, []);
assert.deepEqual(
  zeroTaxValue.known_flags,
  ["national_tax_delinquent", "local_tax_delinquent"],
  "OCCD03 PB 0건은 국세/지방세 모두 known 해당없음 semantics를 유지해야 한다",
);
const niceWorkoutProfile = collectConnectorProfileUpdates(niceWorkoutAmbiguousResults).profileUpdates.reduce<CompanyProfile>(
  (profile, update) => updateCompanyProfileField(profile, update),
  { confidence: {} },
);
const rehabilitationOnlyCriterion: GrantCriterion = {
  dimension: "credit_status",
  operator: "in",
  value: { flags: ["rehabilitation_in_progress"] },
  kind: "exclusion",
  confidence: 1,
};
const ambiguousWorkoutMatch = matchGrantCriteria([rehabilitationOnlyCriterion], niceWorkoutProfile);
assert.equal(ambiguousWorkoutMatch.rule_trace[0]?.result, "unknown");
assert.equal(
  ambiguousWorkoutMatch.eligibility,
  "conditional",
  "양수 OCCD06 미분리 신호로 one-sided criterion을 false pass 처리하면 안 된다",
);
assert.equal(
  matchGrantCriteria([nationalTaxOnlyCriterion], niceWorkoutProfile).eligibility,
  "eligible",
  "OCCD03 PB 0건은 one-sided tax criterion을 known pass로 유지해야 한다",
);

const registryFetchedAt = new Date("2026-07-14T00:00:00.000Z");
const registryMatches: RegistryMatch[] = [
  {
    method: "exact_biz_no",
    score: 1,
    active: true,
    record: {
      registryType: "sanction",
      flagOrCert: "participation_restricted",
      polarity: "known_on_absence",
      bizNo: "3948603207",
      corpNo: null,
      nameNormalized: "테스트",
      representative: null,
      regionSido: null,
      validFrom: null,
      validUntil: null,
      detail: null,
      source: PROCUREMENT_DEBARMENT_SOURCE,
      sourceFetchedAt: registryFetchedAt,
      confidence: 0.95,
    },
  },
  {
    method: "exact_biz_no",
    score: 1,
    active: true,
    record: {
      registryType: "investment",
      flagOrCert: "tips_backed",
      polarity: "present_only",
      bizNo: "3948603207",
      corpNo: null,
      nameNormalized: "테스트",
      representative: null,
      regionSido: null,
      validFrom: null,
      validUntil: null,
      detail: null,
      source: "jointips",
      sourceFetchedAt: registryFetchedAt,
      confidence: 0.8,
    },
  },
];
const registryResults = new Map<string, ConnectorResult>();
applyRegistryMatches(registryResults, registryMatches, new Set([PROCUREMENT_DEBARMENT_SOURCE]));
const registrySanction = registryResults.get("sanction")?.profileUpdates?.[0];
assert.equal(registrySanction?.provider, "registry");
assert.deepEqual((registrySanction?.value as Record<string, unknown>).flags, ["participation_restricted"]);
assert.deepEqual((registrySanction?.value as Record<string, unknown>).known_flags, ["participation_restricted"]);
const registryInvestment = registryResults.get("investment")?.profileUpdates?.[0];
assert.equal(registryInvestment?.provider, "registry");
assert.equal((registryInvestment?.value as Record<string, unknown>).tips_backed, true);

let kiprisRuns = 0;
let releaseKipris!: () => void;
const kiprisGate = new Promise<void>((resolve) => {
  releaseKipris = resolve;
});
const firstKipris = coalesceKiprisLookup("3948603207", async () => {
  kiprisRuns += 1;
  await kiprisGate;
  return null;
});
const duplicateKipris = coalesceKiprisLookup("3948603207", async () => {
  kiprisRuns += 1;
  return null;
});
assert.equal(firstKipris, duplicateKipris, "동일 사업자의 KIPRIS 월 쿼터 호출은 하나로 합쳐야 한다");
assert.equal(kiprisRuns, 1);
releaseKipris();
await firstKipris;

let startupRuns = 0;
let releaseStartup!: () => void;
const startupGate = new Promise<void>((resolve) => {
  releaseStartup = resolve;
});
const startupLookup = { state: "none" as const, record: null, exactRecordCount: 0 };
const firstStartup = coalesceStartupConfirmationLookup("3948603207", async () => {
  startupRuns += 1;
  await startupGate;
  return startupLookup;
});
const duplicateStartup = coalesceStartupConfirmationLookup("3948603207", async () => {
  startupRuns += 1;
  return startupLookup;
});
assert.equal(firstStartup, duplicateStartup, "동일 사업자의 창업기업확인서 조회는 하나로 합쳐야 한다");
assert.equal(startupRuns, 1);
releaseStartup();
await firstStartup;

let lookupRuns = 0;
let releaseLookup!: () => void;
const lookupGate = new Promise<void>((resolve) => {
  releaseLookup = resolve;
});
const fakeLookupResult = {} as ServiceDataLookupResult;
const firstLookup = coalesceServiceDataLookup("test:single-flight", async () => {
  lookupRuns += 1;
  await lookupGate;
  return fakeLookupResult;
});
const duplicateLookup = coalesceServiceDataLookup("test:single-flight", async () => {
  lookupRuns += 1;
  return fakeLookupResult;
});
assert.equal(
  firstLookup,
  duplicateLookup,
  "동일 사업자·provider의 동시 조회는 서버 파이프라인 하나로 합쳐야 한다",
);
assert.equal(lookupRuns, 1);
releaseLookup();
assert.equal(await firstLookup, fakeLookupResult);

console.log("devServiceDataMonitor.test.ts: all assertions passed");
