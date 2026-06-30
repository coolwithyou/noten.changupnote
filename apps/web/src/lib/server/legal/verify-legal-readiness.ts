import assert from "node:assert/strict";
import { buildLegalReadiness } from "./legalReadiness";
import { renderLegalReadinessMarkdown } from "./legalReadinessReport";

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

const configured = buildLegalReadiness(configuredEnv);
assert.equal(configured.status, "ready");
assert.equal(configured.score, 100);
assert.equal(configured.configuredCount, configured.requiredCount);
assert.equal(configured.missingKeys.length, 0);

const fallback = buildLegalReadiness({ NODE_ENV: process.env.NODE_ENV });
assert.equal(fallback.status, "attention");
assert(fallback.score < 100);
assert(fallback.missingKeys.includes("CUNOTE_LEGAL_OPERATOR_NAME"));
assert(fallback.missingKeys.includes("CUNOTE_PRIVACY_OFFICER_NAME"));

const markdown = renderLegalReadinessMarkdown({
  readiness: fallback,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
assert(markdown.includes("# 창업노트 운영 법무 readiness"));
assert(markdown.includes("## 누락 환경값"));
assert(markdown.includes("CUNOTE_LEGAL_OPERATOR_NAME"));
assert(markdown.includes("| 항목 | 상태 | 설명 | 환경값 |"));
assert(markdown.includes("## 배포 전 확인"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "legal_readiness_configured_env_ready",
    "legal_readiness_fallback_attention",
    "legal_readiness_markdown_report",
  ],
  configured: {
    status: configured.status,
    score: configured.score,
    configuredCount: configured.configuredCount,
    requiredCount: configured.requiredCount,
  },
  fallback: {
    status: fallback.status,
    score: fallback.score,
    missingKeys: fallback.missingKeys.slice(0, 5),
  },
}, null, 2));
