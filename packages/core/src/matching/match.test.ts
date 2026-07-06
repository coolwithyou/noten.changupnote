/**
 * matchGrantCriteria 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/matching/match.test.ts
 *
 * 커버: 조건 0건 → conditional 강등 / fit_score 0 / criteria_extracted false / unknown chip 1건,
 *       조건 1건 이상 → criteria_extracted true.
 */
import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "./match.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const company: CompanyProfile = {
  name: "테스트 기업",
  region: { code: "41", label: "경기" },
  biz_age_months: 24,
  industries: ["ICT"],
  size: "중소",
  business_status: { active: true, label: "정상" },
  confidence: { region: 0.8, biz_age: 0.8, industry: 0.6, size: 0.6 },
};

check("조건 0건이면 conditional로 강등되고 적합도는 0이다", () => {
  const result = matchGrantCriteria([], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.fit_score, 0);
  assert.equal(result.criteria_extracted, false);
});

check("조건 0건이면 unknown chip 1건(other/required/unknown)이 추가된다", () => {
  const result = matchGrantCriteria([], company);
  assert.equal(result.rule_trace.length, 1);
  const entry = result.rule_trace[0];
  assert.ok(entry);
  assert.equal(entry.dimension, "other");
  assert.equal(entry.kind, "required");
  assert.equal(entry.result, "unknown");
  assert.notEqual(entry.operator, "text_only"); // UI에서 unknown chip으로 표시되어야 함
  assert.match(entry.message, /구조화되지 않았/);
  assert.deepEqual(result.unknown_fields, ["other"]);
});

check("조건 1건 이상이면 criteria_extracted true", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      value: { regions: ["41"], labels: ["경기"] },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.criteria_extracted, true);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.rule_trace.length, 1);
});

console.log(`\nmatch.test.ts: ${passed} checks passed.`);
