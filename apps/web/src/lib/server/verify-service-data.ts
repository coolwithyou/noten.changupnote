import assert from "node:assert/strict";
import { closeCunoteDb } from "./db/client";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE = "true";

const {
  getServiceRepositories,
  loadServiceApplySheet,
  loadServiceDashboard,
  loadServiceGrants,
} = await import("./serviceData");

const asOf = new Date("2026-06-26T00:00:00.000+09:00");
const userId = "00000000-0000-4000-8000-000000000001";
const grants = await loadServiceGrants({ limit: 8, asOf });

assert.ok(grants.some((entry) => entry.grant.source === "kstartup"), "service grants should include K-Startup sample");
assert.ok(grants.some((entry) => entry.grant.source === "bizinfo"), "service grants should include BizInfo sample");

const company = await getServiceRepositories().companies.createCompany({
  userId,
  profile: {
    name: "서비스 데이터 검증 기업",
    region: { code: "41", label: "경기" },
    biz_age_months: 26,
    industries: ["ICT", "SaaS"],
    size: "중소",
  },
});
const dashboard = await loadServiceDashboard({ companyId: company.id, userId, limit: 8, asOf });
const limitedDashboard = await loadServiceDashboard({
  companyId: company.id,
  userId,
  limit: 1,
  asOf,
  writeMatchStates: false,
});
const limitedEvaluatedCount = limitedDashboard.counts.eligible +
  limitedDashboard.counts.conditional +
  limitedDashboard.counts.ineligible;
assert.equal(limitedDashboard.matches.length, 1, "dashboard response limit should cap only returned cards");
assert.ok(limitedEvaluatedCount > limitedDashboard.matches.length, "dashboard counts must evaluate beyond response limit");
const bizInfoMatch = dashboard.matches.find((match) => match.source === "bizinfo");

// 자동 검수·승격 전 needs_core_review 공고도 원문 확인 후보로 접근 가능해야 한다.
// runtime sample은 promotion ledger가 없으므로 discovery projection 자체가 아니라 UI 계약을 검증한다.
assert.equal(bizInfoMatch?.recommendationTier, "needs_core_review");
assert.equal(bizInfoMatch?.scoreDisplay, "hidden");
assert.ok(dashboard.matches.length > 1, "dashboard should expose multiple service matches");
const bizInfoApplySheet = await loadServiceApplySheet(encodeURIComponent("bizinfo:PBLN_SAMPLE"), {
  companyId: company.id,
  userId,
  limit: 80,
  asOf,
});
assert.ok(bizInfoApplySheet, "BizInfo sample apply sheet should resolve");
assert.deepEqual(
  bizInfoApplySheet.documents.map((document) => document.name),
  ["신청서", "사업자등록증", "재무제표", "사업계획서"],
);
assert.deepEqual(
  bizInfoApplySheet.sourceAttachments.map((attachment) => attachment.filename),
  ["사업계획서.hwp"],
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "service_grants_kstartup_sample",
    "service_grants_bizinfo_sample",
    "service_dashboard_exposes_unreviewed_bizinfo_as_source_check",
    "service_dashboard_full_scan_separate_from_response_limit",
    "service_bizinfo_apply_documents",
    "service_bizinfo_apply_attachments",
  ],
  grants: grants.map((entry) => ({
    source: entry.grant.source,
    sourceId: entry.grant.source_id,
  })),
  bizInfoMatch: {
    recommendationTier: bizInfoMatch.recommendationTier,
    scoreDisplay: bizInfoMatch.scoreDisplay,
  },
  bizInfoApplySheet: {
    documents: bizInfoApplySheet.documents.map((document) => document.name),
    sourceAttachments: bizInfoApplySheet.sourceAttachments.map((attachment) => attachment.filename),
  },
}, null, 2));

await closeCunoteDb();
