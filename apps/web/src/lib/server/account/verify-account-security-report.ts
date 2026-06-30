import assert from "node:assert/strict";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { AccountSecurityStatus } from "./accountSecurityStatus";
import { buildAccountSecurityReport, renderAccountSecurityReport } from "./accountSecurityReport";

const access: CompanyAccess = {
  companyId: "00000000-0000-4000-8000-000000000101",
  userId: "00000000-0000-4000-8000-000000000201",
  role: "owner",
  mode: "session",
};

const status: AccountSecurityStatus = {
  userId: access.userId,
  provider: "nextauth",
  email: "owner@example.test",
  name: "대표 사용자",
  passwordCredential: "configured",
  legalAcceptance: "accepted",
  termsAcceptedAt: "2026-06-01T00:00:00.000Z",
  privacyAcceptedAt: "2026-06-01T00:00:00.000Z",
  termsVersion: "2026.06",
  privacyVersion: "2026.06",
  currentTermsVersion: "2026.06",
  currentPrivacyVersion: "2026.06",
};

const generatedAt = new Date("2026-06-30T00:00:00.000Z");
const markdown = renderAccountSecurityReport({ access, status, generatedAt });
const report = buildAccountSecurityReport({ access, status, generatedAt });

assert(markdown.includes("# owner@example.test 보안 리포트"));
assert(markdown.includes("## 요약"));
assert(markdown.includes("## 회사 접근권한"));
assert(markdown.includes("| 역할 | 소유자 |"));
assert(markdown.includes("## 법무 동의"));
assert(markdown.includes("| 이용약관 |"));
assert(markdown.includes("## 운영 법무 설정"));
assert(markdown.includes("## 제외 항목"));
assert(markdown.includes("## 운영 액션"));
assert(markdown.includes("비밀번호 hash"));
assert.equal(report.fallbackFilename, "cunote-account-security-2026-06-30.md");
assert(report.filename.includes("창업노트-owner@example.test-계정보안-2026-06-30.md"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "account_security_report_heading",
    "account_security_report_summary",
    "account_security_report_access",
    "account_security_report_legal_acceptance",
    "account_security_report_exclusions",
    "account_security_report_next_actions",
    "account_security_report_filename",
  ],
}, null, 2));
