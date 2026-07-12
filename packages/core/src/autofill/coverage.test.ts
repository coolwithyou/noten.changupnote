import assert from "node:assert/strict";
import type { CriterionDimension } from "@cunote/contracts";
import {
  OPERATIONAL_AUTOFILL_DIMENSIONS,
  classifyEvidenceSourceKind,
  measureAutofillCoverage,
  type AutofillCoverageRow,
} from "./coverage.js";

assert.equal(OPERATIONAL_AUTOFILL_DIMENSIONS.length, 19);
assert.equal(OPERATIONAL_AUTOFILL_DIMENSIONS.includes("premises" as never), false);
assert.equal(OPERATIONAL_AUTOFILL_DIMENSIONS.includes("export_performance" as never), false);
assert.equal(OPERATIONAL_AUTOFILL_DIMENSIONS.includes("other" as never), false);

assert.equal(
  classifyEvidenceSourceKind({ provider: "codef", dimension: "founder_age", status: "cache" }),
  "auth_supplied",
);
assert.equal(
  classifyEvidenceSourceKind({ provider: "codef", dimension: "region", status: "cache" }),
  "authoritative_api",
);
assert.equal(
  classifyEvidenceSourceKind({ provider: "registry", dimension: "certification", status: "live" }),
  "public_registry",
);

const row = (
  dimension: CriterionDimension,
  overrides: Partial<AutofillCoverageRow> = {},
): AutofillCoverageRow => ({
  dimension,
  parentKey: null,
  status: "live",
  sourceKind: "authoritative_api",
  axisCompleteness: "complete",
  ...overrides,
});

const codefIdentityDoesNotRaiseApiCoverage = measureAutofillCoverage([
  row("region"),
  row("founder_age", { status: "cache", sourceKind: "auth_supplied" }),
  row("founder_trait", { status: "cache", sourceKind: "auth_supplied" }),
]);
assert.deepEqual(codefIdentityDoesNotRaiseApiCoverage.authoritative_axis_coverage, {
  numerator: 1,
  denominator: 19,
  ratio: 1 / 19,
});
assert.equal(codefIdentityDoesNotRaiseApiCoverage.total_answered_coverage.numerator, 3);

const childFlagDoesNotCompleteParent = measureAutofillCoverage([
  row("sanction", {
    status: "pending",
    sourceKind: null,
    axisCompleteness: "unknown",
  }),
  row("sanction", {
    parentKey: "sanction",
    sourceKind: "public_registry",
    axisCompleteness: "partial",
  }),
]);
assert.equal(childFlagDoesNotCompleteParent.authoritative_axis_coverage.numerator, 0);
assert.equal(childFlagDoesNotCompleteParent.total_answered_coverage.numerator, 0);

const weighted = measureAutofillCoverage(
  [row("region"), row("revenue", { status: "pending", sourceKind: null, axisCompleteness: "unknown" })],
  { region: 3, revenue: 1 },
);
assert.deepEqual(weighted.grant_weighted_coverage, {
  numerator: 3,
  denominator: 4,
  ratio: 0.75,
});

console.log("autofill/coverage.test.ts: all assertions passed");
