import assert from "node:assert/strict";
import { PROFILE_FIELD_SPEC_BY_KEY } from "@cunote/core";
import { measureAutofillCoverage } from "@cunote/core/autofill/coverage";
import {
  buildFieldCoverage,
  coalesceKiprisLookup,
  coalesceServiceDataLookup,
  coalesceStartupConfirmationLookup,
  profileFieldKeyForCoverageRow,
  type ConnectorResult,
  type ServiceDataLookupResult,
} from "./devServiceDataMonitor";

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
assert.equal(
  codefRows.filter((row) => row.parentKey === null && row.dimension !== null).length,
  22,
  "criterion dimension 부모 행은 정확히 하나씩 유지해야 한다",
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

const codefMetrics = measureAutofillCoverage(codefRows);
assert.equal(codefMetrics.authoritative_axis_coverage.numerator, 1);
assert.equal(codefMetrics.total_answered_coverage.numerator, 3); // region + 인증 입력 age + 사업자번호 파생 target_type

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
