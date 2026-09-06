import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
import { buildProductReadinessReport, loadProductReadinessReport } from "./report";

// 기대값은 구현 출력으로 생성하지 않는다. 제품 규칙에서 직접 작성한 합성 사례다.
const seoul: GrantCriterion = { dimension: "region", kind: "required", operator: "in", value: { regions: ["11"], labels: ["서울"] }, confidence: 1, source_span: "서울 소재 기업" };
const cases: { id: string; company: CompanyProfile; criteria: GrantCriterion[]; expected: string }[] = [
  { id: "region-confirmed-pass", company: { region: { code: "11", label: "서울" } }, criteria: [seoul], expected: "eligible" },
  { id: "region-confirmed-fail", company: { region: { code: "26", label: "부산" } }, criteria: [seoul], expected: "ineligible" },
  { id: "unknown-is-not-no", company: {}, criteria: [seoul], expected: "conditional" },
  { id: "complete-profile-is-not-eligible", company: { region: { code: "26", label: "부산" }, industries: ["정보통신업"], biz_age_months: 12, target_types: ["법인"] }, criteria: [seoul], expected: "ineligible" },
  { id: "unanalysed-grant-is-not-user-missing", company: { region: { code: "11", label: "서울" } }, criteria: [], expected: "conditional" },
  { id: "source-text-needs-review", company: { region: { code: "11", label: "서울" } }, criteria: [seoul, { dimension: "industry", kind: "required", operator: "text_only", value: { note: "원전 분야 참여실적 확인" }, confidence: 0.5 }], expected: "conditional" },
];
for (const item of cases) {
  const first = matchGrantCriteria(item.criteria, item.company, { asOf: new Date("2026-09-06T00:00:00Z") });
  assert.equal(first.eligibility, item.expected, item.id);
  assert.deepEqual(matchGrantCriteria(structuredClone(item.criteria), structuredClone(item.company), { asOf: new Date("2026-09-06T00:00:00Z") }), first, `${item.id}: 결정론`);
  if (item.id === "unanalysed-grant-is-not-user-missing") {
    assert.equal(first.criteria_extracted, false);
    assert.equal(first.review_gate?.scoreDisplay, "hidden");
  }
}

const entry = (id: string, collectedAt: string): NormalizedGrant => ({
  grant: { id, source: "bizinfo", source_id: id, f_authoring_mode: "web_form", title: "합성 공고", agency_primary: null,
    category_l1: null, category_l2: null, support_amount: { unit: "KRW", per: "기업" }, apply_start: null, apply_end: null,
    status: "open", apply_method: {}, url: null, f_regions: [], f_industries: [], f_sizes: [], f_founder_traits: [],
    f_required_certs: [], benefits: [], overall_confidence: 1 },
  raw: { source: "bizinfo", source_id: id, collected_at: collectedAt, payload: {}, status: "published" }, criteria: [],
});
const a = entry("a", "2026-09-05T00:00:00Z");
const b = entry("b", "2026-09-04T00:00:00Z");
const input = { asOf: new Date("2026-09-06T00:00:00Z"), inventory: [a, b], serving: [a], source: "runtime_fixture" as const };
const report = buildProductReadinessReport(input);
assert.equal(report.supply.matchingServing, 1);
assert.equal(report.supply.notInMatchingServing, 1);
assert.equal(report.supply.oldestUnservedCollectionAgeHours, 48);
assert.equal(report.authoring.signals.web_form_guide, 1);
assert.equal(report.authoring.signals.template_fill, 0);
assert.equal(report.promotionToExposureLatency.status, "unavailable");
assert.equal(buildProductReadinessReport({ ...input, inventory: [a], serving: [a] }).supply.oldestUnservedCollectionAgeHours, null);
assert.throws(() => buildProductReadinessReport({ ...input, inventory: [a], serving: [b] }), /집합 변경/);
assert.throws(() => buildProductReadinessReport({ ...input, inventory: [a, a] }), /중복/);
let calls = 0;
await assert.rejects(() => loadProductReadinessReport({ ...input, limit: 1, repository: {
  listActiveGrants: async () => { calls++; return [a, b]; }, findGrantById: async () => null, listGrantsByIds: async () => [],
} }), /상한 초과/);
assert.equal(calls, 2);
console.log(`product casebook: ${cases.length} independent matching cases and read-only readiness gates passed`);
