import assert from "node:assert/strict";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import { measureMsitIncrementalCoverage } from "./coverage.js";

const existing = [
  grant("a", "2026년도 AI 바우처 지원사업", "과학기술정보통신부"),
  grant("b", "양자 기술 사업화 지원 참여기업 모집", "정보통신산업진흥원"),
];
const report = measureMsitIncrementalCoverage({
  announcements: [
    announcement("2026년도 AI 바우처 지원사업", "2026-07-12"),
    announcement("양자 기술 사업화 지원 참여기업 모집 공고", "20260711"),
    announcement("신규 우주 스타트업 육성사업", "2026.06.30"),
    announcement("오래된 공고", "2026-03-01"),
    announcement("미래 공고", "2026-07-13"),
    announcement("날짜 오류", "2026-02-30"),
  ],
  existingGrants: existing,
  asOf: new Date("2026-07-12T12:00:00.000Z"),
  windowDays: 90,
});
assert.equal(report.inWindowCount, 3);
assert.equal(report.exactTitleCount, 1);
assert.equal(report.reviewRequiredCount, 1);
assert.equal(report.likelyUniqueCount, 1);
assert.equal(report.conservativeIncrementalCount, 1);
assert.equal(report.futurePressDateCount, 1);
assert.equal(report.invalidPressDateCount, 1);
assert.equal(report.rows.find((row) => row.subject.startsWith("양자"))?.overlapClass, "review");
assert.throws(() => measureMsitIncrementalCoverage({ announcements: [], existingGrants: [], windowDays: 0 }), /windowDays/);
console.log("msit/coverage.test.ts: all assertions passed");

function announcement(subject: string, pressDt: string) {
  return { subject, pressDt, viewUrl: "https://example.test", deptName: "인공지능정책과" };
}

function grant(sourceId: string, title: string, agency: string): NormalizedGrant {
  const value: Grant = {
    source: "bizinfo",
    source_id: sourceId,
    title,
    agency_jurisdiction: agency,
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
  };
  return { raw: { source: "bizinfo", source_id: sourceId, payload: {}, status: "normalized" }, grant: value, criteria: [] };
}
