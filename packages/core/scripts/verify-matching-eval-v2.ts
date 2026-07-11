/**
 * kstartup-sample-v2 골든 검증 — 결격 시나리오 (node:assert, tsx 실행).
 *
 * 공고매칭 차원 확장 P7: 결격(체납·신용·제재) 시나리오를 실제 kstartup 공고 fixture에 대해 검증.
 * kstartup-sample-v1과 동일한 구조지만 회사 프로필에 결격 플래그를 포함해
 * 체납 fail / 예외 pass / 결격 없는 공고 eligible 의 3가지 클래스를 모두 커버한다.
 *
 * 실행: pnpm exec tsx packages/core/scripts/verify-matching-eval-v2.ts
 */
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
const GOLDEN_FIXTURE_PATH = "packages/core/golden/matching/kstartup-sample-v2.json";
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
assert.equal(metrics.accuracy, 1, "matching golden sample v2 must keep 100% accuracy");
for (const klass of CLASSES) {
  assert.equal(metrics.byClass[klass].recall, 1, `${klass} recall must stay at 100%`);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "matching_golden_cases_v2",
    "disqualification_fail_ineligible",
    "disqualification_exception_pass_conditional",
    "no_disqualification_criteria_eligible",
    "matching_eval_accuracy_v2",
    "matching_eval_class_recall_v2",
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
