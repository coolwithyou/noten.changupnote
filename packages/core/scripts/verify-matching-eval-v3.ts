import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptLegacyFixtureToV3,
  buildMatchingBaselineReport,
  readLegacyMatchingGoldenFixture,
} from "./lib/matching-eval.js";

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = [
  "packages/core/golden/matching/kstartup-sample-v1.json",
  "packages/core/golden/matching/kstartup-sample-v2.json",
];

const fixtures = FIXTURES.map((path) => readLegacyMatchingGoldenFixture(WORKSPACE_ROOT, path));
const datasets = fixtures.map((fixture) => adaptLegacyFixtureToV3(WORKSPACE_ROOT, fixture));
const report = buildMatchingBaselineReport(WORKSPACE_ROOT, FIXTURES);
const annotationSchema = JSON.parse(readFileSync(join(
  WORKSPACE_ROOT,
  "packages/core/golden/matching-v3/annotation-schema.json",
), "utf8")) as Record<string, unknown>;
const seedManifest = JSON.parse(readFileSync(join(
  WORKSPACE_ROOT,
  "packages/core/golden/matching-v3/seed-manifest.json",
), "utf8")) as {
  schemaVersion?: string;
  grantSelection?: Array<{ source?: string; sourceId?: string; status?: string }>;
  companySelection?: Array<{ companyId?: string; businessKind?: string; status?: string }>;
};

assert.equal(report.metrics.total, 9, "legacy compatibility baseline must contain 9 eligibility pairs");
const legacyDrifts = report.results.filter((result) => result.actual !== result.expected);
assert.deepEqual(
  legacyDrifts.map((result) => ({ sourceId: result.sourceId, expected: result.expected, actual: result.actual })),
  [{ sourceId: "178229", expected: "ineligible", actual: "conditional" }],
  "legacy drift must remain limited to the reviewed-safe ineligible-to-conditional downgrade",
);
assert.equal(
  report.results.some((result) => result.actual === "ineligible" && result.expected !== "ineligible"),
  false,
  "legacy compatibility must not introduce an unsafe ineligible",
);
assert.equal(
  report.results.some((result) => result.actual === "eligible" && result.expected !== "eligible"),
  false,
  "legacy compatibility must not introduce a false eligible",
);
assert.equal(report.compatibility.companyAnnotations, 2, "v1/v2 use two distinct company profiles");
assert.equal(report.compatibility.uniqueGrantAnnotations, 8, "v1/v2 cover eight unique K-Startup grants");
assert.equal(report.compatibility.eligibilityPairAnnotations, 9);
assert.equal(report.compatibility.reviewedAnnotations, 0, "legacy labels must not be upgraded to reviewed");
assert.ok(report.limitations.length > 0, "baseline must disclose limitations");
assert.equal(annotationSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.ok(Array.isArray(annotationSchema.oneOf), "annotation schema must define record variants");
const criterionKindEnum = (((annotationSchema.$defs as Record<string, unknown> | undefined)
  ?.criterionAnnotation as Record<string, unknown> | undefined)
  ?.properties as Record<string, unknown> | undefined)
  ?.kind as { enum?: string[] } | undefined;
assert.deepEqual(
  criterionKindEnum?.enum,
  ["required", "preferred", "exclusion"],
  "annotation criterion kind must match GrantCriterion contract",
);
assert.equal(seedManifest.schemaVersion, "matching-v3-seed-v2");
assert.equal(seedManifest.grantSelection?.length, 30, "seed manifest must select 30 grants");
assert.equal(seedManifest.grantSelection?.filter((item) => item.source === "kstartup").length, 20);
assert.equal(seedManifest.grantSelection?.filter((item) => item.source === "bizinfo").length, 10);
assert.equal(seedManifest.companySelection?.length, 5, "seed manifest must reserve five company profiles");
assert.equal(
  new Set(seedManifest.grantSelection?.map((item) => `${item.source}:${item.sourceId}`)).size,
  30,
  "seed grant selection must be unique",
);
assert.equal(
  new Set(seedManifest.companySelection?.map((item) => item.companyId)).size,
  5,
  "seed company selection must be unique",
);

for (const dataset of datasets) {
  for (const company of dataset.companies) {
    assert.equal(company.schemaVersion, "matching-v3");
    assert.equal(company.recordType, "company");
    assert.equal(company.labelStatus, "legacy");
  }
  for (const grant of dataset.grants) {
    assert.equal(grant.schemaVersion, "matching-v3");
    assert.equal(grant.recordType, "grant");
    assert.ok(grant.criteria.length > 0, `${grant.grantId} must retain normalized criteria`);
    for (const criterion of grant.criteria) {
      assert.ok(criterion.criterionId.length > 0);
      assert.ok(criterion.annotationConfidence >= 0 && criterion.annotationConfidence <= 1);
      assert.ok("sourceSpan" in criterion, "legacy evidence absence must be explicit null");
      assert.ok("sourceField" in criterion, "structured evidence absence must be explicit null");
    }
  }
  for (const pair of dataset.eligibilityPairs) {
    assert.equal(pair.schemaVersion, "matching-v3");
    assert.equal(pair.recordType, "eligibility_pair");
    assert.equal(pair.split, "development", "legacy compatibility cases are not holdout evidence");
    assert.equal(pair.labelStatus, "legacy");
  }
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "matching_v3_legacy_loader",
    "matching_v3_company_annotations",
    "matching_v3_grant_annotations",
    "matching_v3_eligibility_pair_annotations",
    "matching_v3_baseline_metrics",
    "matching_v3_safe_legacy_drift",
    "matching_v3_limitations_disclosed",
    "matching_v3_annotation_schema",
    "matching_v3_criterion_kind_contract",
    "matching_v3_seed_manifest",
  ],
  fixtures: report.fixtureVersions,
  metrics: report.metrics,
  compatibility: report.compatibility,
  seed: {
    grants: seedManifest.grantSelection?.length,
    companies: seedManifest.companySelection?.length,
  },
}, null, 2));
