import assert from "node:assert/strict";
import { buildLegalReadiness } from "@/lib/server/legal/legalReadiness";
import { buildSaasReadiness } from "./readiness";
import { buildSaasReleaseChecklist, renderSaasReleaseChecklist } from "./releaseChecklist";

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
  CUNOTE_PRIVACY_PROCESSORS: "Vercel|호스팅|미국|계약 종료 시",
  CUNOTE_PRIVACY_OVERSEAS_TRANSFERS: "Vercel|미국|서비스 호스팅|계정/서비스 이용 기록|계약 종료 시|privacy@example.test",
};

const legalReadiness = buildLegalReadiness(configuredEnv);
const saasReadiness = buildSaasReadiness(configuredEnv);
const generatedAt = new Date("2026-06-30T00:00:00.000Z");
const checklist = buildSaasReleaseChecklist({
  legalReadiness,
  saasReadiness,
  runtime: {
    repositoryAdapter: "runtime",
    webDataSource: "sample",
    authRequired: true,
    authMode: "nextauth",
    authProviders: ["password", "google"],
    databaseConfigured: true,
  },
  generatedAt,
});

assert.equal(checklist.filename, "창업노트-SaaS-release-checklist-2026-06-30.md");
assert.equal(checklist.fallbackFilename, "cunote-saas-release-checklist-2026-06-30.md");
assert(checklist.markdown.includes("# 창업노트 SaaS release checklist"));
assert(checklist.markdown.includes("- status: ready"));
assert(checklist.markdown.includes("## Required Commands"));
assert(checklist.markdown.includes("`pnpm typecheck`"));
assert(checklist.markdown.includes("`pnpm verify:saas-readiness`"));
assert(checklist.markdown.includes("`pnpm verify:outbound-email`"));
assert(checklist.markdown.includes("`CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http`"));
assert(checklist.markdown.includes("`pnpm build:web`"));
assert(checklist.markdown.includes("## Execution Evidence"));
assert(checklist.markdown.includes("| `pnpm typecheck` | pending |"));
assert(checklist.markdown.includes("## Runtime Snapshot"));
assert(checklist.markdown.includes("- repository adapter: runtime"));
assert(checklist.markdown.includes("- auth providers: password, google"));
assert(checklist.markdown.includes("## Operator Notes"));
assert(checklist.markdown.includes("next-env.d.ts"));
assert(checklist.markdown.includes("## Sign-off"));
assert(checklist.markdown.includes("## Rollback Gate"));

const fallbackMarkdown = renderSaasReleaseChecklist({
  legalReadiness: buildLegalReadiness({ NODE_ENV: process.env.NODE_ENV }),
  saasReadiness: buildSaasReadiness({ NODE_ENV: process.env.NODE_ENV }),
  generatedAt,
});
assert(fallbackMarkdown.includes("- status: attention"));
assert(fallbackMarkdown.includes("Legal readiness attention:"));
assert(fallbackMarkdown.includes("CUNOTE_LEGAL_OPERATOR_NAME"));
assert(fallbackMarkdown.includes("- runtime snapshot: unavailable"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "saas_release_checklist_filename",
    "saas_release_checklist_ready_gate",
    "saas_release_checklist_required_commands",
    "saas_release_checklist_execution_evidence",
    "saas_release_checklist_runtime_snapshot",
    "saas_release_checklist_operator_notes",
    "saas_release_checklist_signoff_and_rollback",
    "saas_release_checklist_attention_gate",
  ],
}, null, 2));
