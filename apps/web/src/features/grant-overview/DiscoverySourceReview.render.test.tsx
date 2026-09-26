import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApplySheet } from "@cunote/contracts";
import { GrantOverviewView } from "./GrantOverviewView";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const base = {
  matchingEvidence: { level: "discovery", sourceRevisionSha256: "a".repeat(64), reason: "unreviewed" },
  recommendationTier: "needs_core_review",
  scoreDisplay: "hidden",
  grant: {
    id: "grant-seongsu", source: "kstartup", sourceId: "179187",
    title: "서울창업허브 성수 입주기업 모집", agency: "서울경제진흥원",
    status: "open", supportAmount: { min: null, max: null, unit: "KRW", per: "기업" }, benefits: [],
  },
  satisfied: [], needsCheck: [], documents: [], sourceAttachments: [],
  applicationPrep: { draftableDocuments: [] },
  applyMethod: null, deepLink: "https://www.k-startup.go.kr/notice",
  schedule: { applyStart: "2026-09-03", applyEnd: "2026-09-28", dDay: 2 },
} as unknown as ApplySheet;

const withEvidence = {
  ...base,
  discoverySourceEvidence: {
    sourceRevisionSha256: "a".repeat(64),
    companyFacts: { bizAgeMonths: 29, targetTypes: ["개인사업자"], industries: ["응용 소프트웨어 개발 및 공급업"] },
    excerpts: [{ kind: "attachment_target", label: "첨부 공고문의 대상·신청자격",
      text: "□ 모집대상 및 신청자격\n창업 7년 이내 창업기업\n입주 계약 체결 이후 30일 이내 주소지 이전",
      sourceLabel: "첨부 공고문", sourceUrl: "https://www.k-startup.go.kr/notice.hwp", truncated: false }],
    reviewItems: [{ label: "입주 후 주소지 이전 가능 여부", excerptIndex: 0 }],
    incompleteAttachments: false, exclusionDetailsUnavailable: true,
  },
} as ApplySheet;

const reviewedHtml = renderToStaticMarkup(<GrantOverviewView sheet={withEvidence} />);
assert.ok(reviewedHtml.includes("검토 후보"));
assert.ok(reviewedHtml.includes("공식 증빙으로 확인되지 않았습니다"));
assert.ok(reviewedHtml.includes("응용 소프트웨어 개발 및 공급업"));
assert.ok(reviewedHtml.includes("30일 이내 주소지 이전"));
assert.ok(reviewedHtml.includes("입주 후 주소지 이전 가능 여부"));
assert.ok(reviewedHtml.includes("제외대상 세부 조건을 이 자료에서 확인하지 못했습니다"));
assert.ok(reviewedHtml.includes("https://www.k-startup.go.kr/notice.hwp"));
assert.equal(reviewedHtml.includes("지원 자격이 확인되었습니다"), false);

const fallbackHtml = renderToStaticMarkup(<GrantOverviewView sheet={base} />);
assert.ok(fallbackHtml.includes("현재는 제목·기관·일정 같은 기본 정보만 안내합니다"));
assert.equal(fallbackHtml.includes("30일 이내 주소지 이전"), false);
console.log("discovery detail UI: source evidence and safe fallback rendered");
