import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MatchCard, ProductTeaserResult } from "@cunote/contracts";
import { ExpandedProgramCard } from "./Programs";
import { ResultsHero } from "./ResultsHero";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const noop = () => undefined;
const mixedMatch = {
  grantId: "grant-mixed",
  source: "kstartup",
  sourceId: "source-mixed",
  title: "해외 진출 지원사업",
  agency: "지원기관",
  status: "open",
  eligibility: "conditional",
  bucket: "conditional",
  fitScore: 20,
  matchingEvidence: { level: "verified" },
  ranking: { relevanceScore: null, priorityScore: 30, reasons: [] },
  supportAmount: { label: "최대 1억 원", max: 100_000_000, unit: "KRW", per: "기업" },
  benefits: [],
  applyEnd: "2026-10-01",
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
    {
      criterionId: "criterion-pass",
      dimension: "target_type",
      kind: "required",
      result: "pass",
      label: "법인 또는 개인사업자",
      sourceSpan: "사업자등록을 완료한 법인 또는 개인사업자",
      companyValue: "법인",
      checklistSection: "satisfied",
    },
  ],
  matchConfidence: 0.5,
  rulesetVer: "test",
  scoringVer: "test",
  criteriaExtracted: true,
  recommendationTier: "needs_core_review",
  reviewReasons: [{ code: "unreviewed_criteria", label: "공고 조건 검수 필요" }],
  authoringMode: "unknown",
  writeSupport: "unknown",
  detailUrl: "/grants/grant-mixed",
} as unknown as MatchCard;

const cardHtml = renderToStaticMarkup(
  <ExpandedProgramCard
    match={mixedMatch}
    status="check_source"
    supportSummary={{ kind: "amount", text: "최대 1억 원", accessibleText: "지원 금액 최대 1억 원" }}
    onClose={noop}
    onOpenProfile={noop}
    onPrepare={noop}
    preparing={false}
    onOpenConfirmation={noop}
    virtualBizNo={null}
    companyId="company-1"
  />,
);

assert.ok(cardHtml.includes("충족 확인 1 · 미충족 1 · 미확인 2"));
assert.ok(cardHtml.includes("본점이 부산광역시에 소재한 기업"), "sourceSpan을 공고 조건으로 우선 표시해야 함");
assert.ok(cardHtml.includes("서울"), "비교한 회사 값을 표시해야 함");
assert.ok(cardHtml.includes("이 조건과 비교할 회사 정보가 더 필요해요"));
assert.ok(cardHtml.includes("이 회사 정보 확인하기"));
assert.ok(cardHtml.includes("공고 조건 검수 필요"), "trace가 있어도 card-level review blocker를 보여야 함");
assert.ok(cardHtml.includes("companyId=company-1"), "상세 이동에서 회사 문맥을 보존해야 함");
assert.equal(cardHtml.includes("신청 준비 정보 확인하기"), false, "미확정 카드에 준비 CTA를 일괄 노출하면 안 됨");

const userCheckMatch = {
  ...mixedMatch,
  eligibility: "conditional",
  ruleTrace: [
    mixedMatch.ruleTrace[3]!,
    {
      criterionId: "criterion-track",
      dimension: "other",
      kind: "required",
      result: "text_only",
      label: "신청 트랙",
      sourceSpan: "1:1 밋업은 국내외 유망 스타트업, 디지털 전시는 FLY ASIA 현장 프로그램 참여 기업",
      checklistSection: "needs_check",
      unresolvedReason: "criterion_text_only",
      confirmationNextAction: "admin_source_review",
    },
  ],
  reviewReasons: [{ code: "other", label: "기타 원문 확인 필요" }],
} as unknown as MatchCard;
const userCheckHtml = renderToStaticMarkup(
  <ExpandedProgramCard
    match={userCheckMatch}
    status="check_source"
    supportSummary={{ kind: "fallback", text: "지원 내용은 공고문 참고", accessibleText: "지원 내용은 공고문 참고" }}
    onClose={noop}
    onOpenProfile={noop}
    onPrepare={noop}
    preparing={false}
    onOpenConfirmation={noop}
    virtualBizNo={null}
    companyId="company-1"
  />,
);
assert.ok(userCheckHtml.includes("이 조건만 확인하면 지원 가능 여부를 확정할 수 있어요."));
assert.ok(userCheckHtml.includes("귀사가 아래 공고 조건에 해당하나요?"));
assert.ok(userCheckHtml.includes("확인할 조건"));
assert.ok(userCheckHtml.includes("공고에서 이 조건 확인하기"));
assert.equal(userCheckHtml.includes("비교할 회사 정보가 표시되지 않았어요"), false);

const allTracePassCoreReviewHtml = renderToStaticMarkup(
  <ExpandedProgramCard
    match={{
      ...mixedMatch,
      eligibility: "eligible",
      ruleTrace: [mixedMatch.ruleTrace[3]!],
      reviewReasons: [{ code: "extraction_incomplete", dimension: "other", label: "첨부 조건 분석이 완료되지 않음" }],
    }}
    status="check_source"
    supportSummary={{ kind: "amount", text: "최대 1억 원", accessibleText: "지원 금액 최대 1억 원" }}
    onClose={noop}
    onOpenProfile={noop}
    onPrepare={noop}
    preparing={false}
    onOpenConfirmation={noop}
    virtualBizNo={null}
    companyId="company-1"
  />,
);
assert.ok(allTracePassCoreReviewHtml.includes("공고에서 확인할 조건이 남아 있어요"));
assert.ok(allTracePassCoreReviewHtml.includes("첨부 조건 분석이 완료되지 않음"));
assert.equal(allTracePassCoreReviewHtml.includes("지원서 작성 시작"), false);

function teaserFor(match: MatchCard): ProductTeaserResult {
  return {
    matches: [match],
    counts: { eligible: 0, conditional: 1, ineligible: 0, deadlineSoon: 0 },
    nextQuestion: null,
    privacyNote: "",
  } as unknown as ProductTeaserResult;
}

const conservativeHero = renderToStaticMarkup(
  <ResultsHero teaser={teaserFor(mixedMatch)} onSave={noop} saving={false} />,
);
assert.ok(conservativeHero.includes("살펴볼 공고를 찾았어요"));
assert.equal(conservativeHero.includes("우리 회사와 관련된 공고"), false);
assert.equal(conservativeHero.includes("지금 정보로 확정된 공고가 없어요"), false);

const relevantHero = renderToStaticMarkup(
  <ResultsHero
    teaser={teaserFor({
      ...mixedMatch,
      ranking: { relevanceScore: 70, priorityScore: 30, reasons: ["업종 연관 신호: 수출"] },
    })}
    onSave={noop}
    saving={false}
  />,
);
assert.ok(relevantHero.includes("우리 회사와 관련된 공고를 확인해 보세요"));

const discoveryHero = renderToStaticMarkup(
  <ResultsHero
    teaser={teaserFor({
      ...mixedMatch,
      matchingEvidence: { level: "discovery", sourceRevisionSha256: null, reason: "unreviewed" },
      ranking: { relevanceScore: null, priorityScore: null, reasons: [] },
    })}
    onSave={noop}
    saving={false}
  />,
);
assert.ok(discoveryHero.includes("모집 중인 공고를 살펴보세요"));

console.log("match results UI: candidate hero, full condition evidence, blockers and targeted actions passed");
