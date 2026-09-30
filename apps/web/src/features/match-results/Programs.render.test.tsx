import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MatchCard, ProductTeaserResult } from "@cunote/contracts";
import { EXCLUSION_POLICY_NOTE, ProgramsExperience } from "./Programs";
import { DEFAULT_VISIBLE_OPEN, ExcludedMatchesSection } from "./MatchGroupSections";
import { GrantSummaryCard } from "./GrantSummaryCard";
import { ResultsHero } from "./ResultsHero";
import { groupMatchesForDisplay } from "./logic";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const noop = () => undefined;
const VERIFIED = { level: "verified", sourceRevisionSha256: "a".repeat(64) };

/* ───────── fixtures (디자인 01 공통 샘플 데이터 어휘) ───────── */

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
  matchingEvidence: VERIFIED,
  ranking: { relevanceScore: 70, priorityScore: 30, reasons: ["업력 3년 5개월: 창업 3~7년 차 대상", "관심 목표와 일치: 판로 확대", "세 번째 이유는 숨긴다"] },
  supportAmount: { label: "사업화 자금 최대 1억 2,000만 원", max: 120_000_000, unit: "KRW", per: "기업" },
  benefits: [],
  applyEnd: null,
  dDay: 12,
  ruleTrace: [passTrace, { ...passTrace, criterionId: "criterion-preferred", kind: "preferred" }],
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

const mixedMatch = {
  ...openMatch,
  grantId: "grant-mixed",
  title: "해외 진출 지원사업",
  agency: "지원기관",
  eligibility: "conditional",
  bucket: "conditional",
  ranking: { relevanceScore: null, priorityScore: 30, reasons: [] },
  supportAmount: { label: "최대 1억 원", max: 100_000_000, unit: "KRW", per: "기업" },
  dDay: 11,
  ruleTrace: [
    {
      criterionId: "criterion-fail",
      dimension: "region",
      kind: "required",
      result: "fail",
      label: "부산 소재 기업",
      sourceSpan: "본점이 부산광역시에 소재한 기업",
      companyValue: "서울",
      checklistSection: "needs_check",
    },
    {
      criterionId: "criterion-profile",
      dimension: "export_performance",
      kind: "required",
      result: "unknown",
      label: "수출 실적 보유 기업",
      sourceSpan: "최근 1년 수출 실적을 보유한 기업",
      checklistSection: "needs_check",
      unresolvedReason: "company_profile_missing",
      confirmationNextAction: "company_profile",
    },
    {
      criterionId: "criterion-source",
      dimension: "other",
      kind: "exclusion",
      result: "text_only",
      label: "중복지원 제외 조건",
      sourceSpan: "동일 사업 중복수혜자는 제외할 수 있음",
      checklistSection: "needs_check",
      unresolvedReason: "criterion_needs_review",
      confirmationNextAction: "admin_source_review",
    },
    passTrace,
  ],
  recommendationTier: "needs_core_review",
  reviewReasons: [{ code: "unreviewed_criteria", label: "공고 조건 검수 필요" }],
  detailUrl: "/grants/grant-mixed",
} as unknown as MatchCard;

const oneAnswerMatch = {
  ...openMatch,
  grantId: "grant-one-answer",
  title: "스마트상점 기술보급",
  agency: "소상공인시장진흥공단",
  eligibility: "conditional",
  bucket: "conditional",
  recommendationTier: "needs_profile_input",
  supportAmount: { label: "기술 도입비 최대 500만 원", max: 5_000_000, unit: "KRW", per: "기업" },
  dDay: 45,
  ruleTrace: [
    passTrace,
    {
      criterionId: "criterion-employees",
      dimension: "employee_count",
      kind: "required",
      result: "unknown",
      label: "상시근로자 5인 미만",
      sourceSpan: "상시근로자 5인 미만 소상공인",
      checklistSection: "needs_check",
      action: { type: "progressive", target: "employee_count", label: "지금 확인" },
      unresolvedReason: "company_profile_missing",
      confirmationNextAction: "company_profile",
    },
  ],
  detailUrl: "/grants/grant-one-answer",
} as unknown as MatchCard;

const preparableMatch = {
  ...oneAnswerMatch,
  grantId: "grant-preparable",
  title: "이노비즈 연계 기술개발",
  agency: "중소벤처기업부",
  dDay: null,
  supportAmount: { label: "최대 5,000만 원", max: 50_000_000, unit: "KRW", per: "기업" },
  ruleTrace: [
    passTrace,
    { ...oneAnswerMatch.ruleTrace[1]!, criterionId: "criterion-industry", dimension: "industry", action: { type: "progressive", target: "industry", label: "지금 확인" } },
    { ...oneAnswerMatch.ruleTrace[1]!, criterionId: "criterion-revenue", dimension: "revenue", action: { type: "progressive", target: "revenue", label: "지금 확인" } },
  ],
  detailUrl: "/grants/grant-preparable",
} as unknown as MatchCard;

const oneQuestionAwayMatch = {
  ...openMatch,
  grantId: "grant-one-question",
  title: "소상공인 성장지원 사업",
  agency: "소상공인시장진흥공단",
  eligibility: "conditional",
  bucket: "conditional",
  recommendationTier: "needs_profile_input",
  supportAmount: { label: "최대 2,000만 원", max: 20_000_000, unit: "KRW", per: "기업" },
  dDay: null,
  reviewReasons: [],
  confirmationQuestionCount: 1,
  confirmationQuestionIds: ["question-last"],
  confirmationEligibilityQuestionIds: ["question-last"],
  ruleTrace: [
    passTrace,
    {
      criterionId: "criterion-last",
      dimension: "premises",
      kind: "required",
      result: "text_only",
      label: "입주 시 사업장 이전 가능",
      sourceSpan: "선정된 기업은 입주 후 30일 안에 사업장을 이전해야 함",
      checklistSection: "needs_check",
      unresolvedReason: "criterion_text_only",
      confirmationNextAction: "user_confirmation",
    },
  ],
  detailUrl: "/grants/grant-one-question",
} as unknown as MatchCard;

const periodUnconfirmedMatch = {
  ...mixedMatch,
  grantId: "grant-period",
  title: "경남 식품기업 수출지원",
  agency: "경남테크노파크",
  status: "unknown",
  dDay: null,
  supportAmount: { label: "최대 2,000만 원", max: 20_000_000, unit: "KRW", per: "기업" },
  detailUrl: "/grants/grant-period",
} as unknown as MatchCard;

const upcomingMatch = {
  ...openMatch,
  grantId: "grant-upcoming",
  title: "부산 소상공인 디지털 전환",
  agency: "부산시",
  status: "upcoming",
  dDay: null,
  ranking: { relevanceScore: null, priorityScore: null, reasons: [] },
  supportAmount: { label: "최대 1,000만 원", max: 10_000_000, unit: "KRW", per: "기업" },
  detailUrl: "/grants/grant-upcoming",
} as unknown as MatchCard;

const mismatchMatch = {
  ...openMatch,
  grantId: "grant-mismatch",
  title: "예비창업패키지 2차",
  eligibility: "ineligible",
  bucket: "ineligible",
  recommendationTier: "not_recommended",
  quality: { extractionReadiness: "reviewed", verificationCompleteness: 100 },
  ruleTrace: [
    {
      criterionId: "criterion-preliminary",
      dimension: "business_status",
      kind: "required",
      result: "fail",
      label: "예비창업자",
      sourceSpan: "예비창업자(신청일 기준 사업자 미등록자)",
      companyValue: "2023-04-10 개업",
      checklistSection: "needs_check",
    },
  ],
  detailUrl: "/grants/grant-mismatch",
} as unknown as MatchCard;

const discoveryMatch = {
  ...openMatch,
  grantId: "grant-discovery",
  title: "수출바우처 내수기업 트랙",
  agency: "KOTRA",
  matchingEvidence: { level: "discovery", sourceRevisionSha256: null, reason: "unreviewed" },
  ranking: { relevanceScore: null, priorityScore: null, reasons: [] },
  detailUrl: "/grants/grant-discovery",
} as unknown as MatchCard;

function teaserFor(matches: MatchCard[]): ProductTeaserResult {
  return {
    matches,
    counts: { eligible: 0, conditional: matches.length, ineligible: 0, deadlineSoon: 0 },
    nextQuestion: null,
    privacyNote: "",
  } as unknown as ProductTeaserResult;
}

function renderPrograms(matches: MatchCard[], companyId: string | null = null, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ProgramsExperience
      teaser={teaserFor(matches)}
      onPrepare={noop}
      onOpenProfile={noop}
      preparing={false}
      companyId={companyId}
      {...extra}
    />,
  );
}

/* ───────── 그룹 배분(화면 순서의 전제) ───────── */

const groups = groupMatchesForDisplay([
  openMatch, mixedMatch, oneAnswerMatch, preparableMatch, oneQuestionAwayMatch, periodUnconfirmedMatch, upcomingMatch, mismatchMatch, discoveryMatch,
]);
assert.deepEqual(groups.open.map((match) => match.grantId), ["grant-open"]);
assert.deepEqual(groups.oneQuestionAway.map((match) => match.grantId), ["grant-one-question"]);
assert.deepEqual(groups.oneAnswer.map((match) => match.grantId), ["grant-one-answer"]);
assert.deepEqual(groups.preparable.map((match) => match.grantId), ["grant-preparable"]);
assert.deepEqual(groups.checkSource.map((match) => match.grantId).sort(), ["grant-discovery", "grant-mixed", "grant-period"]);
assert.deepEqual(groups.closed.map((match) => match.grantId), ["grant-mismatch"]);
assert.deepEqual(groups.upcoming.map((match) => match.grantId), ["grant-upcoming"]);

/* ───────── 0 안내 + 1 살펴볼 공고(2열 요약 카드) ───────── */

const fullHtml = renderPrograms([
  openMatch, mixedMatch, oneAnswerMatch, preparableMatch, oneQuestionAwayMatch, periodUnconfirmedMatch, upcomingMatch, mismatchMatch, discoveryMatch,
]);
assert.equal(EXCLUSION_POLICY_NOTE, "확인한 필수조건이 맞지 않는 공고만 제외했어요. 우대 조건·업종 키워드·빈 정보는 제외 사유가 아니에요.");
assert.equal(fullHtml.split(EXCLUSION_POLICY_NOTE).length - 1, 1, "안내는 한 번만 표시한다");

// 섹션 순서(디자인 01): 살펴볼 → 질문 하나로 → 회사 정보 추가 확인 → 더 확인할 후보 → 공고 조건 확인 → 제외 → 접수 예정
const sectionOrder = [
  "살펴볼 공고",
  "질문 하나로 지원 여부 확인",
  "회사 정보 추가 확인",
  "회사 정보를 더 확인할 후보",
  "공고 조건 확인",
  "제외된 공고 보기 · 1건",
  "접수 예정",
].map((title) => fullHtml.indexOf(`>${title}<`) >= 0 ? fullHtml.indexOf(`>${title}<`) : fullHtml.indexOf(title));
assert.ok(sectionOrder.every((index) => index >= 0), `모든 섹션 제목이 있어야 함: ${JSON.stringify(sectionOrder)}`);
assert.deepEqual([...sectionOrder].sort((a, b) => a - b), sectionOrder, "섹션은 디자인 순서대로 나온다");

assert.ok(fullHtml.includes("표시 중 1건"), "살펴볼 공고 건수는 표시 중 N건");
assert.ok(fullHtml.includes("md:grid-cols-2"), "요약 카드는 2열 그리드");
assert.ok(fullHtml.includes("필수 조건 확인 완료"), "필수·제외 조건이 모두 확인된 카드의 상태 줄");
assert.ok(fullHtml.includes("확인된 조건 1/1"), "우대 조건은 분모에서 뺀다");
assert.ok(fullHtml.includes("창업진흥원"), "기관 표시");
assert.ok(fullHtml.includes(">D-12<"), "D-day 표시");
assert.ok(fullHtml.includes("text-danger"), "임박 D-day는 danger 토큰");
assert.ok(fullHtml.includes("사업화 자금 최대 1억 2,000만 원"), "지원 요약");
assert.ok(fullHtml.includes("업력 3년 5개월: 창업 3~7년 차 대상") && fullHtml.includes("관심 목표와 일치: 판로 확대"), "관련성 이유 2줄");
assert.equal(fullHtml.includes("세 번째 이유는 숨긴다"), false, "관련성 이유는 최대 2줄");
assert.ok(fullHtml.includes(">공고 보기<"), "요약 카드 푸터 버튼");
assert.ok(fullHtml.includes('href="/grants/grant-open"'), "제목·버튼이 상세로 이동");

/* ───────── 2 질문 하나로 지원 여부 확인(카드 안 질문 박스) ───────── */

assert.ok(fullHtml.includes("남은 쟁점 1") && fullHtml.includes("확인된 조건 1/2"), "질문 하나 카드의 상태 줄");
assert.ok(fullHtml.includes("회사 정보를 저장하고 답하기"), "익명은 회사 저장 경계 버튼");
assert.ok(fullHtml.includes("입주 시 사업장 이전 가능"), "질문 문구는 조건 라벨");
assert.ok(fullHtml.includes("원문 “선정된 기업은 입주 후 30일 안에 사업장을 이전해야 함”"), "원문 인용은 .src 줄로");
assert.equal(fullHtml.includes("공고별 질문에 답하기"), false, "옛 하단 CTA를 남기지 않는다");

const savedHtml = renderPrograms([oneQuestionAwayMatch], "company-1", { onConfirmationSaved: noop });
assert.ok(savedHtml.includes("확인 질문을 불러오고 있어요"), "회사가 있으면 인라인 확인 질문을 카드 안에 넣는다");
assert.ok(savedHtml.includes("companyId=company-1"), "상세 이동에서 회사 문맥을 보존한다");
assert.equal(savedHtml.includes("회사 정보를 저장하고 답하기"), false);

/* ───────── 3 회사 정보 추가 확인 / 4 더 확인할 후보 / 5 공고 조건 확인 ───────── */

assert.ok(fullHtml.includes("스마트상점 기술보급") && fullHtml.includes("기술 도입비 최대 500만 원") && fullHtml.includes(">D-45<"), "한 줄 행 메타: 기관 · D-day · 지원 요약");
assert.ok(fullHtml.includes("직접 확인할 조건 1개"), "회사 정보 추가 확인 캡션은 explainMatch summary");
assert.ok(fullHtml.includes("검토 준비 중"), "더 확인할 후보는 검토 준비 중 상태");
assert.ok(fullHtml.includes("border-dashed"), "검토 준비 중 점은 점선 원");
assert.ok(fullHtml.includes("원문 확인 필요"), "공고 조건 확인 행의 상태 줄");
assert.ok(fullHtml.includes("접수 여부 확인 필요"), "접수 기간 미확인 카드는 탐색 사유 캡션을 보여 준다");
assert.ok(fullHtml.includes("접수 기간 원문 미확인"), "접수 기간 미확인 카드의 메타 줄");
assert.ok(fullHtml.includes(">공고 원문 보기<"), "공고 조건 확인 행 버튼");
assert.ok(fullHtml.includes("AI가 읽음"), "discovery 카드에는 AI가 읽음 칩");

/* ───────── 7 제외된 공고 보기(익명) / 8 접수 예정 ───────── */

assert.ok(fullHtml.includes("제외된 공고 보기 · 1건"), "익명 결과는 제외 목록을 접힌 섹션으로");
assert.equal(fullHtml.includes("다시 살펴볼 공고로 복원"), false, "익명 제외 목록에는 복원 버튼이 없다");
const excludedHtml = renderToStaticMarkup(
  <ExcludedMatchesSection matches={[mismatchMatch]} hrefFor={(match) => `/grants/${match.grantId}`} defaultOpen />,
);
assert.ok(excludedHtml.includes("현재 확인한 필수조건 불일치로 제외한 공고입니다. 마감한 공고는 검토 목록에 포함하지 않습니다."));
assert.ok(excludedHtml.includes("확인한 필수조건과 회사 정보가 맞지 않습니다."), "제외 사유");
assert.ok(excludedHtml.includes("원문 “예비창업자(신청일 기준 사업자 미등록자)” · 회사 정보: 2023-04-10 개업"), "실패 조건 원문 인용");
assert.ok(excludedHtml.includes("예비창업패키지 2차"));

assert.ok(fullHtml.includes("모집 예정"), "접수 예정 행 캡션");
assert.ok(fullHtml.includes("부산 소상공인 디지털 전환") && fullHtml.includes("최대 1,000만 원"));
assert.equal(fullHtml.includes(">접수 예정</span>"), false, "옛 NoticeCard의 접수 예정 보조 라벨은 없다");

/* ───────── 옛 구조 부재 + 금지 어휘 ───────── */

assert.equal(fullHtml.includes("카드 접기"), false, "카드 펼침 상세를 두지 않는다");
assert.equal(fullHtml.includes("hover:bg-card"), false, "NoticeCard 토글 버튼 껍데기가 없다");
assert.equal(fullHtml.includes("공고 상세 및 조건 근거 보기"), false);
assert.equal(fullHtml.includes("지원 여부를 결정하는 조건"), false, "조건 표는 공고 요약 페이지 담당");
for (const label of ["자격 충족 확인", "내 정보 확인", "현재 신청 어려움"]) {
  assert.equal(fullHtml.includes(label), false, `판정 뱃지 라벨(${label})을 목록 카드에 쓰지 않는다`);
}
assert.doesNotMatch(fullHtml, /\d+%/, "백분율을 노출하지 않는다");
assert.doesNotMatch(fullHtml, /매칭률|선정 확률|충족 확인 \d+ · 미충족/);

/* ───────── 더 보기(기본 6장) ───────── */

const manyOpen = Array.from({ length: DEFAULT_VISIBLE_OPEN + 2 }, (_, index) => ({
  ...openMatch,
  grantId: `grant-open-${index}`,
  title: `살펴볼 공고 ${index}`,
})) as MatchCard[];
const manyHtml = renderPrograms(manyOpen);
assert.equal(DEFAULT_VISIBLE_OPEN, 6);
assert.ok(manyHtml.includes(`표시 중 ${DEFAULT_VISIBLE_OPEN}건`));
assert.ok(manyHtml.includes("2건 더 보기"));
assert.equal(manyHtml.includes("살펴볼 공고 7"), false, "7번째 카드부터는 더 보기 뒤에 나온다");

/* ───────── 요약 카드 단독: NEW 뱃지 · 상시 ───────── */

const newCardHtml = renderToStaticMarkup(
  <GrantSummaryCard match={{ ...oneQuestionAwayMatch, dDay: null } as MatchCard} href="/grants/x" isNew />,
);
assert.ok(newCardHtml.includes(">NEW<"));
assert.ok(newCardHtml.includes(">상시<"), "dDay가 없으면 상시");
assert.ok(newCardHtml.includes('data-product-grant="grant-one-question"'), "노출 계측용 속성 유지");

/* ───────── ResultsHero(변경 없음) ───────── */

const conservativeHero = renderToStaticMarkup(
  <ResultsHero teaser={teaserFor([mixedMatch])} onSave={noop} saving={false} />,
);
assert.ok(conservativeHero.includes("살펴볼 공고를 찾았어요"));
const oneQuestionHero = renderToStaticMarkup(
  <ResultsHero teaser={teaserFor([oneQuestionAwayMatch])} onSave={noop} saving={false} />,
);
assert.ok(oneQuestionHero.includes("질문 하나로 지원 여부를 확인할 공고 1건이 있어요."));

console.log("match results UI: design-01 sections, summary cards, list rows, excluded list and forbidden vocabulary passed");
