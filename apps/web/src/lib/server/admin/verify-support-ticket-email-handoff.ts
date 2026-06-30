import assert from "node:assert/strict";
import { renderSupportTicketEmailHandoff } from "./supportTicketEmailHandoff";

process.env.CUNOTE_SUPPORT_EMAIL = "support@changupnote.com";

const handoff = renderSupportTicketEmailHandoff({
  ticket: {
    id: "ticket-verify-12345678",
    email: "founder@example.com",
    name: "검증 고객",
    subject: "계정 접근 문의",
    category: "account",
    message: "로그인 후 신청 관리 화면에 접근할 수 없습니다.",
    createdAt: "2026-06-30T00:00:00.000Z",
  },
  message: {
    body: "확인했습니다. 계정 권한을 다시 동기화해 주세요.",
    createdAt: "2026-06-30T01:00:00.000Z",
  },
  admin: {
    userId: "admin-verify",
    mode: "demo",
  },
  generatedAt: new Date("2026-06-30T02:00:00.000Z"),
});

assert.equal(handoff.filename, "창업노트-계정 접근 문의-이메일답변.eml");
assert.equal(handoff.fallbackFilename, "cunote-support-reply-ticket-v.eml");
assert(handoff.eml.includes("From: =?UTF-8?B?"));
assert(handoff.eml.includes("To: <founder@example.com>"));
assert(handoff.eml.includes("Subject: =?UTF-8?B?"));
assert(handoff.eml.includes("Content-Type: text/plain; charset=UTF-8"));
assert(handoff.eml.includes("X-Cunote-Handoff: support-ticket-email"));
assert(handoff.eml.includes("확인했습니다. 계정 권한을 다시 동기화해 주세요."));
assert(handoff.eml.includes("----- 원문 문의 -----"));
assert(handoff.eml.includes("접수번호: ticket-verify-12345678"));
assert(handoff.eml.includes("운영자: admin-verify (demo)"));

const fallback = renderSupportTicketEmailHandoff({
  ticket: {
    id: "ticket-fallback-12345678",
    email: "founder@example.com",
    name: null,
    subject: "답변 전 문의",
    category: "product",
    message: "아직 답변이 없습니다.",
    createdAt: "2026-06-30T00:00:00.000Z",
  },
  message: null,
  admin: {
    userId: "admin-verify",
    mode: "session",
  },
  generatedAt: new Date("2026-06-30T02:00:00.000Z"),
});

assert(fallback.eml.includes("문의 내용을 확인했습니다."));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "support_ticket_email_handoff_filename",
    "support_ticket_email_handoff_headers",
    "support_ticket_email_handoff_latest_reply",
    "support_ticket_email_handoff_original_context",
    "support_ticket_email_handoff_fallback_body",
  ],
}, null, 2));
