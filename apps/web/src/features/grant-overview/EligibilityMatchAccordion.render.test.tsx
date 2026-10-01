import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuleTraceChip } from "@cunote/contracts";
import { Accordion } from "@/components/ui/accordion";
import { EligibilityMatchAccordion } from "./EligibilityMatchAccordion";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const satisfied = [
  {
    criterionId: "region-pass",
    dimension: "region",
    kind: "required",
    result: "pass",
    label: "부산 소재",
    sourceSpan: "부산광역시에 본점 또는 사업장을 둔 기업",
    companyValue: "부산 해운대구 · 국세청",
    checklistSection: "satisfied",
  },
] satisfies RuleTraceChip[];

const needsCheck = [
  {
    criterionId: "failed",
    dimension: "founder_age",
    kind: "required",
    result: "fail",
    label: "대표자 나이",
    sourceSpan: "대표자 만 19세 이상 39세 이하",
    companyValue: "1984년생 · 만 42세 · 회사 프로필",
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
    criterionId: "confirm",
    dimension: "other",
    kind: "exclusion",
    result: "unknown",
    label: "세금 조건 확인",
    sourceSpan: "국세·지방세 체납 중인 기업",
    checklistSection: "needs_check",
    unresolvedReason: "criterion_text_only",
    confirmationNextAction: "user_confirmation",
  },
  {
    criterionId: "source",
    dimension: "other",
    kind: "exclusion",
    result: "text_only",
    label: "중복 수혜 제외",
    sourceSpan: "동일 사업 중복 수혜자는 제외할 수 있음",
    checklistSection: "needs_check",
    unresolvedReason: "criterion_text_only",
    confirmationNextAction: "admin_source_review",
  },
  {
    criterionId: "review",
    dimension: "region",
    kind: "required",
    result: "unknown",
    label: "부산 소재 기준",
    sourceSpan: "부산 소재 기업 (본점 기준인지 사업장 기준인지 원문 표현이 갈림)",
    checklistSection: "needs_check",
    unresolvedReason: "criterion_needs_review",
    confirmationNextAction: "admin_source_review",
  },
  {
    criterionId: "preferred",
    dimension: "other",
    kind: "preferred",
    result: "unknown",
    label: "인증 보유",
    sourceSpan: "여성기업·사회적기업 등 인증 보유 기업",
    checklistSection: "preferred_miss",
    unresolvedReason: "company_profile_missing",
    confirmationNextAction: "company_profile",
  },
] satisfies RuleTraceChip[];

function render(input: {
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  evidenceLevel?: "verified" | "discovery" | null;
}) {
  return renderToStaticMarkup(
    <Accordion value={["eligibility"]}>
      <EligibilityMatchAccordion
        grantId="grant-1"
        companyId="company-1"
        virtualBizNo={null}
        satisfied={input.satisfied}
        needsCheck={input.needsCheck}
        sourceUrl="https://example.com/grant-1"
        {...(input.evidenceLevel === undefined ? {} : { evidenceLevel: input.evidenceLevel })}
      />
    </Accordion>,
  );
}

const html = render({ satisfied, needsCheck, evidenceLevel: "verified" });

// 헤더 집계·캡션·그룹 라벨(우대는 집계 밖).
assert.ok(html.includes("확인된 조건 1/6 · 남은 쟁점 4 · 불일치 1"));
assert.ok(html.includes("내 사업자 정보와 공고 조건 대조"));
assert.ok(html.includes("작성 시작 여부와는 별개예요"));
assert.ok(html.includes("필수 · 제외"));
assert.ok(html.includes("우대 · 집계에 넣지 않아요"));

// 열1: 종류 뱃지 3종 + 검수 칩(시트 verified → 검수됨, 검수 대기 조건만 AI가 읽음).
assert.ok(html.includes(">필수</span>"));
assert.ok(html.includes(">제외</span>"));
assert.ok(html.includes(">우대</span>"));
assert.ok(html.includes(">검수됨</span>"));
assert.equal(html.split(">AI가 읽음</span>").length - 1, 1);

// 열2: 조건 문장(원문 구절) + 출처 줄(공고 원문 · 기준명, 검수 전).
assert.ok(html.includes("부산광역시에 본점 또는 사업장을 둔 기업"));
assert.ok(html.includes("최근 매출 10억원 이하"));
assert.ok(html.includes("공고 원문 · 부산 소재</div>"));
assert.ok(html.includes("공고 원문 · 부산 소재 기준 · 검수 전"));

// 열3: 6상태 라벨 전부 + 근거 + 행동 링크.
for (const status of ["met", "unmet", "ask", "per", "src", "wait"]) {
  assert.ok(html.includes(`data-condition-status="${status}"`), `row status ${status}`);
}
assert.ok(html.includes(">충족</span>"));
assert.ok(html.includes(">미충족</span>"));
assert.ok(html.includes(">내 답 필요</span>"));
assert.ok(html.includes(">공고별 확인</span>"));
assert.ok(html.includes(">원문 확인 필요</span>"));
assert.ok(html.includes(">검토 준비 중</span>"));
assert.ok(html.includes("부산 해운대구 · 국세청"));
assert.ok(html.includes("1984년생 · 만 42세 · 회사 프로필"));
assert.ok(html.includes("이 조건과 비교할 회사 정보가 더 필요해요."));
assert.ok(html.includes("이 공고에서만 확인하는 질문이에요. 답하면 다시 판단해요."));
assert.ok(html.includes("이 회사 정보 확인하기"));
assert.ok(html.includes("profile=revenue"));
assert.ok(html.includes("companyId=company-1"));
assert.ok(html.includes("이 공고 질문 확인하기"));
assert.ok(html.includes("confirm=grant-1"));
assert.ok(html.includes("원문에서 해당 문장 보기"));
assert.ok(html.includes('href="https://example.com/grant-1" target="_blank"'));

// 내 답 필요 행(필수·제외)만 연한 브랜드 배경으로 강조. 우대 행의 내 답 필요는 강조하지 않는다.
assert.equal(html.split("bg-surface-brand").length - 1, 1);
// 패널 기본 링크 밑줄을 끈다(디자인 .lnk).
assert.ok(html.includes("[&amp;_a]:no-underline"));
assert.ok(!/\[&amp;_a\]:underline[\s"]/.test(html));

// 옛 구조(조건별 카드 + 2×2 사실 표 + StatusBadge 어휘)와 금지 어휘가 없다.
for (const stale of ["현재 판단", "다음 행동", "<dl", "<dt", "충족 확인", "공고 원문 근거 보기", "필수 조건<", "우대·평가"]) {
  assert.ok(!html.includes(stale), `stale text ${stale}`);
}
// 금지 어휘(core 이유 문장의 "지원·가능" 표현)가 화면에 새지 않는다.
assert.ok(!/지원\s?가능/.test(html));

// 시트 수준이 없으면 검수 칩을 생략하고, discovery 면 전부 AI가 읽음.
const legacyHtml = render({ satisfied, needsCheck: needsCheck.slice(0, 2) });
assert.ok(!legacyHtml.includes("검수됨"));
assert.ok(!legacyHtml.includes("AI가 읽음"));
const discoveryHtml = render({ satisfied, needsCheck: needsCheck.slice(0, 2), evidenceLevel: "discovery" });
assert.ok(!discoveryHtml.includes("검수됨"));
assert.equal(discoveryHtml.split(">AI가 읽음</span>").length - 1, 3);

// 필수·제외 조건이 없으면 빈 상태를 유지한다.
const emptyHtml = render({ satisfied: [], needsCheck: [], evidenceLevel: "verified" });
assert.ok(emptyHtml.includes("매칭 확인 중"));
assert.ok(emptyHtml.includes("비교할 필수·제외 조건이 아직 정리되지 않았어요"));
assert.ok(!emptyHtml.includes("data-condition-status"));

console.log("grant overview UI: 3-column condition rows with 6 states, trust chips, evidence and action links passed");

assert.ok(html.includes("내 사업자 정보"));
assert.ok(html.includes("비교할 회사 정보 미확인"));
