import assert from "node:assert/strict";
import { buildSaasReadiness } from "./readiness";
import { renderSaasReadinessMarkdown } from "./readinessReport";

const configuredEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CUNOTE_LEGAL_OPERATOR_NAME: "창업노트 주식회사",
  CUNOTE_SUPPORT_EMAIL: "support@example.test",
  CUNOTE_PRIVACY_EMAIL: "privacy@example.test",
  CUNOTE_PRIVACY_OFFICER_NAME: "개인정보 책임자",
  CUNOTE_BUSINESS_REGISTRATION_NUMBER: "000-00-00000",
  CUNOTE_BUSINESS_ADDRESS: "서울특별시 중구 테스트로 1",
  CUNOTE_MAIL_ORDER_REGISTRATION_NUMBER: "제2026-서울테스트-0000호",
  CUNOTE_LEGAL_EFFECTIVE_DATE: "2026-06-30",
  CUNOTE_TERMS_VERSION: "v2026.06.30",
  CUNOTE_PRIVACY_VERSION: "v2026.06.30",
  CUNOTE_PRIVACY_RETENTION_SUMMARY: "회원 탈퇴 또는 삭제 요청 처리 후 법정 보존 기간 동안 보관합니다.",
  CUNOTE_PRIVACY_PROCESSORS: "Vercel|호스팅|미국|계약 종료 시;Cloudflare|보안/CDN|미국|계약 종료 시",
  CUNOTE_PRIVACY_OVERSEAS_TRANSFERS: "Vercel|미국|서비스 호스팅|계정/서비스 이용 기록|계약 종료 시|privacy@example.test",
};

const configured = buildSaasReadiness(configuredEnv);
if (configured.status !== "ready") {
  console.error(JSON.stringify({
    configuredStatus: configured.status,
    configuredScore: configured.score,
    missingKeys: configured.missingKeys,
  }, null, 2));
}
assert.equal(configured.status, "ready");
assert.equal(configured.score, 100);
assert.equal(configured.readyCount, configured.totalCount);
assert.equal(configured.missingKeys.length, 0);
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("script:verify:support-ticket-transcript"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("test:verify:support-ticket-transcript"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("script:verify:billing-webhook"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("test:verify:billing-webhook"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("script:verify:outbound-email"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("test:verify:outbound-email"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("script:verify:saas-release-checklist"))
));
assert(configured.sections.some((section) =>
  section.items.some((item) => item.evidence.includes("test:verify:saas-release-checklist"))
));

const fallback = buildSaasReadiness({ NODE_ENV: process.env.NODE_ENV });
assert.equal(fallback.status, "attention");
assert(fallback.score < 100);
assert(fallback.readyCount >= fallback.totalCount - 1);
assert(fallback.missingKeys.some((key) => key.includes("admin_operations.legal_readiness")));

const sectionKeys = new Set(configured.sections.map((section) => section.key));
for (const key of [
  "public_trust",
  "activation",
  "core_workflow",
  "workspace_operations",
  "commercial_operations",
  "admin_operations",
]) {
  assert(sectionKeys.has(key), `missing readiness section ${key}`);
}

const markdown = renderSaasReadinessMarkdown({
  readiness: configured,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
assert(markdown.includes("# 창업노트 SaaS MVP readiness"));
assert(markdown.includes("## 공개 신뢰 흐름"));
assert(markdown.includes("| 항목 | 상태 | 설명 | Evidence / Missing |"));
assert(markdown.includes("script:verify:support-ticket-transcript"));
assert(markdown.includes("test:verify:support-ticket-transcript"));
assert(markdown.includes("script:verify:billing-webhook"));
assert(markdown.includes("test:verify:billing-webhook"));
assert(markdown.includes("script:verify:outbound-email"));
assert(markdown.includes("test:verify:outbound-email"));
assert(markdown.includes("script:verify:saas-release-checklist"));
assert(markdown.includes("test:verify:saas-release-checklist"));
assert(markdown.includes("## 다음 운영 액션"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "saas_readiness_route_coverage",
    "saas_readiness_configured_env_ready",
    "saas_readiness_fallback_attention",
    "saas_readiness_verifier_script_evidence",
    "saas_readiness_test_chain_evidence",
    "saas_readiness_markdown_report",
  ],
  configured: {
    status: configured.status,
    score: configured.score,
    readyCount: configured.readyCount,
    totalCount: configured.totalCount,
  },
  fallback: {
    status: fallback.status,
    score: fallback.score,
    readyCount: fallback.readyCount,
    totalCount: fallback.totalCount,
    missingKeys: fallback.missingKeys.slice(0, 5),
  },
}, null, 2));
