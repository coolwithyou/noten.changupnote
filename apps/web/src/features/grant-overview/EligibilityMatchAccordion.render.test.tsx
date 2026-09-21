import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuleTraceChip } from "@cunote/contracts";
import { Accordion } from "@/components/ui/accordion";
import { EligibilityMatchAccordion } from "./EligibilityMatchAccordion";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const traces = [
  {
    criterionId: "failed",
    dimension: "region",
    kind: "required",
    result: "fail",
    label: "부산 소재",
    sourceSpan: "본점이 부산에 소재한 기업",
    companyValue: "서울",
    checklistSection: "needs_check",
  },
  {
    criterionId: "profile",
    dimension: "revenue",
    kind: "required",
    result: "unknown",
    label: "매출 조건",
    sourceSpan: "최근 매출 10억원 이하",
    checklistSection: "needs_check",
    unresolvedReason: "company_profile_missing",
    confirmationNextAction: "company_profile",
  },
  {
    criterionId: "source",
    dimension: "other",
    kind: "exclusion",
    result: "text_only",
    label: "중복 수혜 제외",
    sourceSpan: "동일 사업 중복 수혜자는 제외할 수 있음",
    checklistSection: "needs_check",
    unresolvedReason: "criterion_needs_review",
    confirmationNextAction: "admin_source_review",
  },
] satisfies RuleTraceChip[];

const html = renderToStaticMarkup(
  <Accordion value={["eligibility"]}>
    <EligibilityMatchAccordion
      grantId="grant-1"
      companyId="company-1"
      virtualBizNo={null}
      satisfied={[]}
      needsCheck={traces}
      sourceUrl="https://example.com/grant-1"
    />
  </Accordion>,
);

assert.ok(html.includes("충족 확인 0 · 미충족 1 · 미확인 2"));
assert.ok(html.includes("본점이 부산에 소재한 기업"));
assert.ok(html.includes("최근 매출 10억원 이하"));
assert.ok(html.includes("회사 정보"));
assert.ok(html.includes("현재 판단"));
assert.ok(html.includes("다음 행동"));
assert.ok(html.includes("profile=revenue"));
assert.ok(html.includes("companyId=company-1"));
assert.ok(html.includes("공고 원문 근거 보기"));

console.log("grant overview UI: full condition rows, state reasons and context-bound actions passed");
