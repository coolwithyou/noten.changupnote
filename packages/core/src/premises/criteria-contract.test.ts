import assert from "node:assert/strict";
import type { GrantCriterion } from "@cunote/contracts";
import { validateGrantCriteriaContract } from "../bizinfo/criteria-contract.js";

const valid: GrantCriterion = {
  dimension: "premises",
  kind: "required",
  operator: "exists",
  value: {
    schemaVersion: "premises-v1",
    state: "registered_current_site",
    sidoCodes: ["11"],
    facilityTypes: ["headquarters", "factory"],
    facilitySemantics: "any",
    basisDate: "2026-09-09",
  },
  confidence: 0.95,
  source_span: "2026년 9월 9일 현재 서울특별시에 등록된 본사 또는 공장을 둔 기업",
  needs_review: false,
};

assert.deepEqual(validateGrantCriteriaContract([valid]), []);

for (const [label, patch] of [
  ["review state absent", { needs_review: undefined }],
  ["unreviewed", { needs_review: true }],
  ["preferred", { kind: "preferred" }],
  ["unsupported operator", { operator: "in" }],
  ["missing span", { source_span: undefined }],
  ["district", { source_span: "2026년 9월 9일 현재 서울특별시 강남구에 등록된 본사를 둔 기업" }],
  ["future", { source_span: "선정 후 서울특별시로 본사를 이전할 예정인 기업" }],
  ["evidence", { source_span: "2026년 9월 9일 현재 법인등기부등본상 서울특별시에 등록된 본사를 둔 기업" }],
  ["tenure", { source_span: "2026년 9월 9일 기준 1년 이상 계속하여 서울특별시에 등록된 본사를 둔 기업" }],
] as const) {
  const issues = validateGrantCriteriaContract([{ ...valid, ...patch }]);
  assert.ok(issues.length > 0, `${label} must fail premises-v1 admission`);
}

assert.ok(validateGrantCriteriaContract([{
  ...valid,
  value: { ...valid.value, districtCodes: ["11680"] },
}]).some((issue) => issue.message.includes("additional property")));
assert.ok(validateGrantCriteriaContract([{
  ...valid,
  dimension: "export_performance",
  value: { note: "최근 수출 실적" },
}]).some((issue) => issue.message.includes("reserved dimension")), "export remains reserved");

console.log("premises-v1 criteria contract tests passed");
