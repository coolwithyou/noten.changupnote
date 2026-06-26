import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  CompanyProfile,
  MatchResult,
} from "@cunote/contracts";
import type { KStartupApiResponse } from "../src/index.js";
import {
  matchGrantCriteria,
  normalizeKStartupPayload,
} from "../src/index.js";

type Eligibility = MatchResult["eligibility"];

interface GoldenCase {
  sourceId: string;
  expected: Eligibility;
  note: string;
}

interface MatchingGoldenFixture {
  goldenVer: string;
  fixture: string;
  asOf: string;
  company: CompanyProfile;
  cases: GoldenCase[];
}

interface EvalResult extends GoldenCase {
  actual: Eligibility;
  fitScore: number;
  unknownFields: string[];
}

const CLASSES: Eligibility[] = ["eligible", "conditional", "ineligible"];
const goldenFixture = readMatchingGoldenFixture("packages/core/golden/matching/kstartup-sample-v1.json");
const asOf = new Date(goldenFixture.asOf);
const fixture = JSON.parse(
  readFileSync(goldenFixture.fixture, "utf8"),
) as KStartupApiResponse;
const company = goldenFixture.company;
const goldenCases = goldenFixture.cases;

const grants = normalizeKStartupPayload(fixture, { asOf, collectedAt: asOf });
const bySourceId = new Map(grants.map((item) => [item.grant.source_id, item]));
const results: EvalResult[] = goldenCases.map((goldenCase) => {
  const item = bySourceId.get(goldenCase.sourceId);
  assert.ok(item, `golden case sourceId must exist: ${goldenCase.sourceId}`);
  const match = matchGrantCriteria(item.criteria, company);
  return {
    ...goldenCase,
    actual: match.eligibility,
    fitScore: match.fit_score,
    unknownFields: match.unknown_fields,
  };
});

for (const result of results) {
  assert.equal(
    result.actual,
    result.expected,
    `${result.sourceId} expected ${result.expected}, got ${result.actual}`,
  );
}

const metrics = computeMetrics(results);
assert.equal(metrics.accuracy, 1, "matching golden sample must keep 100% accuracy");
for (const klass of CLASSES) {
  assert.equal(metrics.byClass[klass].recall, 1, `${klass} recall must stay at 100%`);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "matching_golden_cases",
    "matching_golden_fixture",
    "matching_eval_accuracy",
    "matching_eval_class_recall",
  ],
  goldenVer: goldenFixture.goldenVer,
  cases: results.map((result) => ({
    sourceId: result.sourceId,
    expected: result.expected,
    actual: result.actual,
    fitScore: result.fitScore,
    unknownFields: result.unknownFields,
    note: result.note,
  })),
  metrics,
}, null, 2));

function readMatchingGoldenFixture(path: string): MatchingGoldenFixture {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MatchingGoldenFixture>;
  assert.equal(typeof parsed.goldenVer, "string", "golden fixture must include goldenVer");
  assert.equal(typeof parsed.fixture, "string", "golden fixture must include fixture path");
  assert.equal(typeof parsed.asOf, "string", "golden fixture must include asOf");
  assert.ok(parsed.company && typeof parsed.company === "object", "golden fixture must include company");
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, "golden fixture must include cases");

  for (const entry of parsed.cases) {
    assert.ok(entry.sourceId, "golden case must include sourceId");
    assert.ok(CLASSES.includes(entry.expected), `golden case ${entry.sourceId} has invalid expected class`);
    assert.ok(entry.note, `golden case ${entry.sourceId} must include note`);
  }

  return parsed as MatchingGoldenFixture;
}

function computeMetrics(results: EvalResult[]) {
  const correct = results.filter((result) => result.actual === result.expected).length;
  const byClass = Object.fromEntries(CLASSES.map((klass) => {
    const expected = results.filter((result) => result.expected === klass).length;
    const predicted = results.filter((result) => result.actual === klass).length;
    const truePositive = results.filter((result) => result.expected === klass && result.actual === klass).length;
    return [klass, {
      expected,
      predicted,
      truePositive,
      precision: predicted === 0 ? 0 : truePositive / predicted,
      recall: expected === 0 ? 0 : truePositive / expected,
    }];
  })) as Record<Eligibility, {
    expected: number;
    predicted: number;
    truePositive: number;
    precision: number;
    recall: number;
  }>;

  return {
    total: results.length,
    correct,
    accuracy: correct / results.length,
    byClass,
  };
}
