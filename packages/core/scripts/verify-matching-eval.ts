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

interface EvalResult extends GoldenCase {
  actual: Eligibility;
  fitScore: number;
  unknownFields: string[];
}

const CLASSES: Eligibility[] = ["eligible", "conditional", "ineligible"];
const asOf = new Date("2026-06-26T00:00:00.000+09:00");
const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const company: CompanyProfile = {
  id: "demo-company",
  name: "(가칭)테크스타트",
  region: { code: "41", label: "경기" },
  biz_age_months: 26,
  founder_age: 35,
  is_preliminary: false,
  industries: ["ICT", "SW"],
  size: "중소",
  confidence: {
    region: 0.95,
    biz_age: 0.9,
    founder_age: 0.9,
    industry: 0.65,
    size: 0.65,
  },
};

const goldenCases: GoldenCase[] = [
  { sourceId: "178246", expected: "eligible", note: "경기 소재 7년 미만/예비 허용" },
  { sourceId: "178223", expected: "eligible", note: "청년 창업자 연령 조건 충족" },
  { sourceId: "178235", expected: "conditional", note: "업종 확인 필요" },
  { sourceId: "178231", expected: "conditional", note: "규모/업종 확인 필요" },
  { sourceId: "178245", expected: "ineligible", note: "수도권 제외" },
  { sourceId: "178249", expected: "ineligible", note: "서울 대상" },
];

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
    "matching_eval_accuracy",
    "matching_eval_class_recall",
  ],
  goldenVer: "kstartup-sample-v1",
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
