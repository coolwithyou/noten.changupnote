import assert from "node:assert/strict";
import type { DashboardResult } from "@cunote/contracts";
import { buildDashboardReport, renderDashboardReport } from "./dashboardReport";

const dashboard: DashboardResult = {
  company: {
    name: "검증 주식회사",
    region: "서울",
    size: "중소",
    bizAgeMonths: 36,
    industries: ["ICT", "AI"],
  },
  counts: {
    eligible: 1,
    conditional: 1,
    ineligible: 2,
    deadlineSoon: 1,
  },
  matches: [
    {
      grantId: "grant-1",
      source: "kstartup",
      sourceId: "178319",
      title: "검증 지원사업",
      agency: "검증기관",
      status: "open",
      eligibility: "eligible",
      bucket: "now",
      fitScore: 92,
      supportAmount: { max: 50_000_000, unit: "KRW", per: "기업" },
      benefits: [],
      applyEnd: "2026-07-10",
      dDay: 3,
      ruleTrace: [],
      matchConfidence: 0.91,
      rulesetVer: "ruleset-test",
      scoringVer: "scoring-test",
      authoringMode: "file_form",
      writeSupport: "ai_draft",
      detailUrl: "/grants/grant-1",
    },
    {
      grantId: "grant-2",
      source: "bizinfo",
      sourceId: "BIZ-1",
      title: "확인 필요 사업",
      agency: null,
      status: "open",
      eligibility: "conditional",
      bucket: "conditional",
      fitScore: 71,
      supportAmount: { label: "바우처", unit: "KRW", per: "기업" },
      benefits: [],
      applyEnd: null,
      dDay: null,
      ruleTrace: [],
      matchConfidence: 0.74,
      rulesetVer: "ruleset-test",
      scoringVer: "scoring-test",
      authoringMode: "web_form",
      writeSupport: "web_form_guide",
      detailUrl: null,
    },
  ],
  roadmap: [],
  nextQuestion: {
    dimension: "region",
    definitionId: "profile.region.v1",
    prompt: "지역 정보를 확인해 주세요.",
    inputType: "select",
    preciseFollowUp: "never",
    framing: "조건부 판단을 확정하는 데 도움이 됩니다.",
    affectedGrantCount: 2,
    options: ["서울", "경기"],
  },
  actionQueue: [
    {
      id: "apply:grant-1",
      kind: "apply",
      title: "검증 지원사업 신청 일정 확인",
      reason: "마감 D-3",
      ctaLabel: "신청 준비",
      target: "/grants/grant-1",
      affectedGrantIds: ["grant-1"],
      affectedGrantCount: 1,
      leverageAmount: 50_000_000,
      urgency: "high",
      effort: "long",
      score: 120,
    },
  ],
  rulesetVer: "ruleset-test",
  scoringVer: "scoring-test",
};

const generatedAt = new Date("2026-06-30T00:00:00.000Z");
const markdown = renderDashboardReport({ dashboard, generatedAt });
const report = buildDashboardReport({ dashboard, generatedAt });

assert(markdown.includes("# 검증 주식회사 · 서울 · 중소 기회 맵 리포트"));
assert(markdown.includes("## 요약"));
assert(markdown.includes("| 지금 적격 | 1건 |"));
assert(markdown.includes("## 회사 기준"));
assert(markdown.includes("ICT, AI"));
assert(markdown.includes("## 상위 기회"));
assert(markdown.includes("검증 지원사업"));
assert(markdown.includes("## 우선 액션"));
assert(markdown.includes("검증 지원사업 신청 일정 확인"));
assert(markdown.includes("## 다음 보강 질문"));
assert(markdown.includes("지역 정보를 확인해 주세요."));
assert(markdown.includes("## 운영 액션"));
assert.equal(report.fallbackFilename, "cunote-dashboard-report-2026-06-30.md");
assert.equal(report.filename, "창업노트-기회맵-2026-06-30.md");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "dashboard_report_heading",
    "dashboard_report_summary",
    "dashboard_report_company_basis",
    "dashboard_report_matches",
    "dashboard_report_action_queue",
    "dashboard_report_next_question",
    "dashboard_report_filename",
  ],
}, null, 2));
