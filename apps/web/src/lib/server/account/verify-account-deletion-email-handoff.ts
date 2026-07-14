import assert from "node:assert/strict";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import {
  accountDeletionEmailHandoffDownloadResponse,
  buildAccountDeletionEmailHandoff,
} from "./accountDeletionEmailHandoff";

process.env.CUNOTE_PRIVACY_EMAIL = "privacy@changupnote.com";
process.env.CUNOTE_SUPPORT_EMAIL = "support@changupnote.com";
process.env.CUNOTE_LEGAL_OPERATOR_NAME = "검증 운영사";

const access: CompanyAccess = {
  companyId: "00000000-0000-4000-8000-000000000101",
  userId: "00000000-0000-4000-8000-000000000201",
  role: "owner",
  mode: "session",
};

const session: WebSession = {
  provider: "mock",
  user: {
    id: "00000000-0000-4000-8000-000000000201",
    email: "owner@example.com",
    name: "검증 사용자",
  },
};

const handoff = buildAccountDeletionEmailHandoff({
  access,
  session,
  asOf: new Date("2026-06-30T00:00:00.000Z"),
});
const response = accountDeletionEmailHandoffDownloadResponse(handoff);
const body = await response.text();

assert.equal(handoff.filename, "창업노트-owner@example.com-삭제요청.eml");
assert.equal(handoff.fallbackFilename, "cunote-account-deletion-request-00000000-0000-4000-8000-000000000101.eml");
assert.equal(response.status, 200);
assert(response.headers.get("content-type")?.includes("message/rfc822"));
assert(response.headers.get("content-disposition")?.includes("attachment"));
assert(body.includes("From: =?UTF-8?B?"));
assert(body.includes("To: =?UTF-8?B?"));
assert(body.includes("<privacy@changupnote.com>"));
assert(body.includes("Reply-To: <owner@example.com>"));
assert(body.includes("Subject: =?UTF-8?B?"));
assert(body.includes("Content-Type: text/plain; charset=UTF-8"));
assert(body.includes("X-Cunote-Handoff: account-deletion-request-email"));
assert(body.includes("검증 운영사 개인정보 담당자님"));
assert(body.includes("요청자: 검증 사용자"));
assert(body.includes("회신 이메일: owner@example.com"));
assert(body.includes(`회사 ID: ${access.companyId}`));
assert(body.includes(`사용자 ID: ${session.user.id}`));
assert(body.includes("현재 권한: owner"));
assert(body.includes("/settings?section=data"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "account_deletion_email_handoff_filename",
    "account_deletion_email_handoff_download_headers",
    "account_deletion_email_handoff_mail_headers",
    "account_deletion_email_handoff_identity",
    "account_deletion_email_handoff_scope",
    "account_deletion_email_handoff_service_path",
  ],
}, null, 2));
