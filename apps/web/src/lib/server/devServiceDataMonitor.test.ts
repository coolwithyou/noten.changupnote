import assert from "node:assert/strict";
import { measureAutofillCoverage } from "@cunote/core/autofill/coverage";
import {
  buildFieldCoverage,
  coalesceServiceDataLookup,
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
