import assert from "node:assert/strict";

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
const bizInfoMatch = dashboard.matches.find((match) => match.source === "bizinfo");

assert.ok(bizInfoMatch, "dashboard should expose BizInfo sample match");
assert.equal(bizInfoMatch.eligibility, "eligible");
assert.ok(dashboard.matches.length > 1, "dashboard should expose multiple service matches");
const bizInfoApplySheet = await loadServiceApplySheet(encodeURIComponent(bizInfoMatch.grantId), {
  companyId: company.id,
  userId,
  limit: 80,
  asOf,
});
assert.ok(bizInfoApplySheet, "BizInfo sample apply sheet should resolve");
assert.deepEqual(
  bizInfoApplySheet.documents.map((document) => document.name),
  ["신청서", "사업자등록증", "재무제표"],
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
    "service_dashboard_bizinfo_match",
    "service_bizinfo_apply_documents",
    "service_bizinfo_apply_attachments",
  ],
  grants: grants.map((entry) => ({
    source: entry.grant.source,
    sourceId: entry.grant.source_id,
  })),
  bizInfoMatch: {
    grantId: bizInfoMatch.grantId,
    eligibility: bizInfoMatch.eligibility,
  },
  bizInfoApplySheet: {
    documents: bizInfoApplySheet.documents.map((document) => document.name),
    sourceAttachments: bizInfoApplySheet.sourceAttachments.map((attachment) => attachment.filename),
  },
}, null, 2));
