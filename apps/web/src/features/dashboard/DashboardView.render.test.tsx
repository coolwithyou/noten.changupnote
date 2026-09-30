import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { DashboardResult, MatchCard, MatchingProfileView } from "@cunote/contracts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { DashboardView, comparedMatchCount, dashboardHeaderCaption } = await import("./DashboardView");

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const passTrace = {
  criterionId: "criterion-pass",
  dimension: "target_type",
  kind: "required",
  result: "pass",
  label: "법인 또는 개인사업자",
  sourceSpan: "사업자등록을 완료한 법인 또는 개인사업자",
  companyValue: "법인",
  checklistSection: "satisfied",
};

const openMatch = {
  grantId: "grant-open",
  source: "kstartup",
  sourceId: "source-open",
  title: "창업도약패키지",
  agency: "창업진흥원",
  status: "open",
  eligibility: "eligible",
  bucket: "now",
  fitScore: 80,
  matchingEvidence: { level: "verified", sourceRevisionSha256: "a".repeat(64) },
  ranking: { relevanceScore: 70, priorityScore: 30, reasons: ["업력 3년 5개월: 창업 3~7년 차 대상"] },
  supportAmount: { label: "사업화 자금 최대 1억 2,000만 원", max: 120_000_000, unit: "KRW", per: "기업" },
  benefits: [],
  applyEnd: null,
  dDay: 12,
  ruleTrace: [passTrace],
  matchConfidence: 0.9,
  rulesetVer: "test",
  scoringVer: "test",
  criteriaExtracted: true,
  recommendationTier: "recommendable",
  reviewReasons: [],
  authoringMode: "unknown",
  writeSupport: "unknown",
  detailUrl: "/grants/grant-open",
} as unknown as MatchCard;

const upcomingMatch = {
  ...openMatch,
  grantId: "grant-upcoming",
  title: "부산 소상공인 디지털 전환",
  agency: "부산시",
  status: "upcoming",
  dDay: null,
  supportAmount: { label: "최대 1,000만 원", max: 10_000_000, unit: "KRW", per: "기업" },
  detailUrl: "/grants/grant-upcoming",
} as unknown as MatchCard;

const profileView: MatchingProfileView = {
  asOf: "2026-09-30T02:10:00.000Z",
  knownCount: 7,
  partialCount: 1,
  unknownCount: 2,
  rows: Array.from({ length: 10 }, (_, index) => ({ dimension: `dim-${index}` })) as unknown as MatchingProfileView["rows"],
};

const dashboard = {
  company: { name: "주식회사 바다상회", region: "부산 해운대구", size: "소상공인", bizAgeMonths: 41, industries: ["음식료품 도소매"] },
  counts: { eligible: 1, conditional: 0, ineligible: 0, deadlineSoon: 1, recommendable: 3, reviewNeeded: 520, notRecommended: 5, openNow: 1 },
  matches: [openMatch, upcomingMatch],
  roadmap: [],
  actionQueue: [{
    id: "action-1",
    kind: "input",
    title: "상시근로자 수를 알려 주세요",
    reason: "공고 2건의 판정이 이 값에 달려 있어요",
    ctaLabel: "지금 답하기",
    target: "/settings",
    affectedGrantIds: ["grant-open", "grant-upcoming"],
    affectedGrantCount: 2,
    leverageAmount: 0,
    urgency: "high",
    effort: "quick",
    score: 10,
  }],
  rulesetVer: "test",
  scoringVer: "test",
  profileView,
} as unknown as DashboardResult & { profileView: MatchingProfileView };

/* ───────── 헤더 캡션 규칙 ───────── */

assert.equal(comparedMatchCount(dashboard.counts), 528, "추천 tier 3분류 합이 전체 비교 건수");
assert.equal(comparedMatchCount({ eligible: 0, conditional: 0, ineligible: 0, deadlineSoon: 0 }), null, "셀 수 없으면 null");
assert.equal(
  dashboardHeaderCaption({ companyName: "주식회사 바다상회", asOf: "2026-09-30T02:10:00.000Z", counts: dashboard.counts }),
  "주식회사 바다상회의 저장된 정보 기준 · 9월 30일 모집 중 528건 중 관련 후보를 골랐어요",
);
assert.equal(
  dashboardHeaderCaption({ companyName: "주식회사 바다상회", asOf: null, counts: { eligible: 0, conditional: 0, ineligible: 0, deadlineSoon: 0 }, now: new Date("2026-10-01T00:30:00.000Z") }),
  "주식회사 바다상회의 저장된 정보 기준 · 10월 1일 관련 후보를 골랐어요",
  "비교 건수를 모르면 '모집 중 N건 중' 구를 빼고 날짜는 오늘(KST)",
);
assert.equal(
  dashboardHeaderCaption({ companyName: "바다상회", asOf: "2026-09-30T16:00:00.000Z", counts: dashboard.counts }),
  "바다상회의 저장된 정보 기준 · 10월 1일 모집 중 528건 중 관련 후보를 골랐어요",
  "UTC 16시는 KST 다음 날",
);

/* ───────── 화면 SSR ───────── */

const html = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <DashboardView dashboard={dashboard} companyId="company-1" />
  </AppRouterContext.Provider>,
);

assert.ok(html.includes(">기회 맵</h1>"), "h1은 기회 맵");
assert.ok(html.includes("주식회사 바다상회의 저장된 정보 기준 · 9월 30일 모집 중 528건 중 관련 후보를 골랐어요"), "헤더 캡션");
assert.ok(html.includes("관련성 높은 순"), "정렬 라벨(동작 없음)");
assert.ok(html.includes("max-w-[1100px]"), "2열 그리드에 맞는 페이지 폭");
assert.ok(html.includes("상시근로자 수를 알려 주세요") && html.includes(">지금 답하기<"), "오늘 확인할 것 카드는 유지");
assert.equal(html.includes("오늘 확인할 것 하나예요"), false, "옛 h1 문구를 쓰지 않는다");

assert.ok(html.includes("확인한 필수조건이 맞지 않는 공고만 제외했어요."), "안내 한 줄");
assert.ok(html.includes(">살펴볼 공고</h2>") && html.includes("표시 중 1건"), "살펴볼 공고 섹션");
assert.ok(html.includes("md:grid-cols-2"), "요약 카드 2열 그리드");
assert.ok(html.includes("필수 조건 확인 완료") && html.includes("확인된 조건 1/1"), "카드 상태 줄");
assert.ok(html.includes(">공고 보기<"), "카드 버튼");
assert.ok(html.includes('href="/grants/grant-open?companyId=company-1"'), "회사 문맥을 상세 링크에 보존");
assert.ok(html.includes(">접수 예정</h2>") && html.includes("모집 예정"), "접수 예정 섹션");
assert.ok(html.includes("다시 살펴볼 공고") || html.includes("제외된 공고 보기"), "회사 결과는 서버 저장 탐색 선택 패널을 그린다");
assert.ok(html.includes("자동으로 확인한 정보 7개 · 직접 채울 정보 3개 · 보기"), "하단 프로필 링크 유지");

for (const removed of ["지금 가능", "답하면 확정", "매칭 정밀도", "회사를 더 설명할수록", "카드 접기", 'data-slot="tabs', "hover:bg-card"]) {
  assert.equal(html.includes(removed), false, `옛 탭·게이지·펼침 구조(${removed})가 없어야 함`);
}
assert.doesNotMatch(html, /\d+%/, "백분율을 노출하지 않는다");
assert.doesNotMatch(html, /매칭률|선정 확률|지원 가능 \d/);

// 다음 40건 — 첫 페이지가 전체보다 적을 때만 버튼
assert.ok(html.includes("다음 40건 불러오기"), "전체 528건 중 2건만 불러왔으므로 더 불러오기 버튼");
assert.ok(html.includes("전체 528건 중 2건을 불러왔어요."));
const completeHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <DashboardView
      dashboard={{ ...dashboard, counts: { eligible: 1, conditional: 1, ineligible: 0, deadlineSoon: 1 } }}
      companyId="company-1"
    />
  </AppRouterContext.Provider>,
);
assert.equal(completeHtml.includes("다음 40건 불러오기"), false, "전부 불러왔으면 버튼 없음");

// 빈 결과 + 행동 없음
const emptyHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <DashboardView dashboard={{ ...dashboard, matches: [], actionQueue: [], counts: { eligible: 0, conditional: 0, ineligible: 0, deadlineSoon: 0 } }} companyId="company-1" />
  </AppRouterContext.Provider>,
);
assert.ok(emptyHtml.includes("지금 바로 제안할 행동이 없어요"));
assert.ok(emptyHtml.includes("현재 확인된 매칭 결과가 없어요."));
assert.ok(emptyHtml.includes("의 저장된 정보 기준 · ") && emptyHtml.includes("관련 후보를 골랐어요"));
assert.equal(emptyHtml.includes("모집 중 0건"), false);

console.log(JSON.stringify({
  ok: true,
  checked: ["header_caption_rules", "h1_and_sort_label", "primary_action_kept", "design01_sections_ssr", "old_tabs_gauge_removed", "pagination_button", "empty_state"],
  htmlBytes: Buffer.byteLength(html),
}, null, 2));
