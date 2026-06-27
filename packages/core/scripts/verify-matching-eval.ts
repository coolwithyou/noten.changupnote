import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const GOLDEN_FIXTURE_PATH = "packages/core/golden/matching/kstartup-sample-v1.json";
const goldenFixture = readMatchingGoldenFixture(join(WORKSPACE_ROOT, GOLDEN_FIXTURE_PATH));
const asOf = new Date(goldenFixture.asOf);
const fixture = JSON.parse(
  readFileSync(join(WORKSPACE_ROOT, goldenFixture.fixture), "utf8"),
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
    "matching_golden_fixture_file",
    "matching_golden_fixture_as_of",
    "matching_golden_fixture_unique_source_ids",
    "matching_golden_fixture_class_coverage",
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
  const goldenVer = requireString(parsed.goldenVer, "golden fixture must include goldenVer");
  const fixturePath = requireString(parsed.fixture, "golden fixture must include fixture path");
  const asOfValue = requireString(parsed.asOf, "golden fixture must include asOf");
  assert.ok(parsed.company && typeof parsed.company === "object", "golden fixture must include company");
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, "golden fixture must include cases");

  const expectedGoldenVer = basename(path, extname(path));
  assert.equal(goldenVer, expectedGoldenVer, "golden fixture goldenVer must match file name");

  const asOf = new Date(asOfValue);
  assert.ok(!Number.isNaN(asOf.getTime()), "golden fixture asOf must be a valid date");
  assert.ok(!isAbsolute(fixturePath), "golden fixture source path must be workspace-relative");
  assert.ok(
    existsSync(join(WORKSPACE_ROOT, fixturePath)),
    `golden fixture source path must exist: ${fixturePath}`,
  );

  const sourceIds = new Set<string>();
  const expectedClasses = new Set<Eligibility>();
  const cases = parsed.cases as Partial<GoldenCase>[];
  for (const entry of cases) {
    const sourceId = requireString(entry.sourceId, "golden case must include sourceId");
    assert.ok(sourceId.trim().length > 0, "golden case sourceId must not be empty");
    assert.ok(!sourceIds.has(sourceId), `golden case sourceId must be unique: ${sourceId}`);
    sourceIds.add(sourceId);

    const expected = entry.expected as Eligibility;
    assert.ok(CLASSES.includes(expected), `golden case ${sourceId} has invalid expected class`);
    expectedClasses.add(expected);

    const note = requireString(entry.note, `golden case ${sourceId} must include note`);
    assert.ok(note.trim().length > 0, `golden case ${sourceId} note must not be empty`);
  }

  for (const klass of CLASSES) {
    assert.ok(expectedClasses.has(klass), `golden fixture must include at least one ${klass} case`);
  }

  return {
    goldenVer,
    fixture: fixturePath,
    asOf: asOfValue,
    company: parsed.company as CompanyProfile,
    cases: cases as GoldenCase[],
  };
}

function requireString(value: unknown, message: string): string {
  assert.equal(typeof value, "string", message);
  return value as string;
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
