import assert from "node:assert/strict";
import {
  passwordResetEmailHandoffDownloadResponse,
  renderPasswordResetEmailHandoff,
} from "./passwordResetEmailHandoff";

process.env.CUNOTE_SUPPORT_EMAIL = "support@changupnote.com";

const handoff = renderPasswordResetEmailHandoff({
  email: "founder@example.com",
  resetUrl: "https://changupnote.com/reset-password?token=verify-reset-token&callbackUrl=%2Fdashboard",
  expiresInMinutes: 30,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
const response = passwordResetEmailHandoffDownloadResponse(handoff);
const body = await response.text();

assert.equal(handoff.filename, "창업노트-founder@example.com-비밀번호재설정.eml");
assert.equal(handoff.fallbackFilename, "cunote-password-reset-founder-example-com.eml");
assert.equal(response.status, 200);
assert(response.headers.get("content-type")?.includes("message/rfc822"));
assert(response.headers.get("content-disposition")?.includes("attachment"));
assert(body.includes("From: =?UTF-8?B?"));
assert(body.includes("To: <founder@example.com>"));
assert(body.includes("Subject: =?UTF-8?B?"));
assert(body.includes("Content-Type: text/plain; charset=UTF-8"));
assert(body.includes("X-Cunote-Handoff: password-reset-email"));
assert(body.includes("창업노트 비밀번호 재설정 안내입니다."));
assert(body.includes("요청 이메일: founder@example.com"));
assert(body.includes("링크 만료: 30분"));
assert(body.includes("https://changupnote.com/reset-password?token=verify-reset-token&callbackUrl=%2Fdashboard"));
assert(body.includes("링크는 한 번 사용하거나 만료 시간이 지나면 사용할 수 없습니다."));
assert(body.includes("문의: support@changupnote.com"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "password_reset_email_handoff_filename",
    "password_reset_email_handoff_download_headers",
    "password_reset_email_handoff_mail_headers",
    "password_reset_email_handoff_link_context",
    "password_reset_email_handoff_security_notice",
  ],
}, null, 2));
