import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CriterionKind, CriterionOperator, PriorAwardCriterionValue } from "@cunote/contracts";
import { adaptPriorAwardCriterionValue, evaluatePriorAward } from "../src/index.js";

const path = resolve("packages/core/golden/matching/prior-award-legacy-regression-v1.json");
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  goldenVer: string;
  snapshotStatus: string;
  expectedCaseCount: number;
  expectedValueKeyCounts: Record<string, number>;
  cases: Array<{
    criterionId: string;
    kind: CriterionKind;
    operator: CriterionOperator;
    value: unknown;
    expectedAdapted: PriorAwardCriterionValue;
  }>;
};
assert.equal(fixture.goldenVer, "prior-award-legacy-regression-v1");
assert.equal(fixture.snapshotStatus, "legacy_format_regression_not_eligibility_truth");
assert.equal(fixture.cases.length, fixture.expectedCaseCount);
assert.equal(fixture.cases.length, 38, "2026-07-12 legacy snapshot must contain 38 rows");
const ids = new Set<string>();
const valueKeyCounts: Record<string, number> = {};
for (const item of fixture.cases) {
  assert.ok(!ids.has(item.criterionId), `duplicate criterionId: ${item.criterionId}`);
  ids.add(item.criterionId);
  assert.deepEqual(adaptPriorAwardCriterionValue(item.value), item.expectedAdapted, `${item.criterionId} adaptV1 drift`);
  const emptyResult = evaluatePriorAward({ value: item.value, kind: item.kind, company: {} });
  assert.equal(emptyResult.result, "unknown", `${item.criterionId} empty profile must never pass`);
  if (isRecord(item.value)) {
    for (const key of Object.keys(item.value)) valueKeyCounts[key] = (valueKeyCounts[key] ?? 0) + 1;
  }
}
assert.deepEqual(valueKeyCounts, fixture.expectedValueKeyCounts, "legacy value-key histogram drift");
for (const key of ["note", "program", "awards", "labels", "period", "support_type", "years"]) {
  assert.ok((valueKeyCounts[key] ?? 0) > 0, `legacy snapshot missing observed key: ${key}`);
}
console.log(JSON.stringify({
  ok: true,
  goldenVer: fixture.goldenVer,
  caseCount: fixture.cases.length,
  valueKeyCounts,
  emptyProfileUnknownCount: fixture.cases.length,
}, null, 2));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
