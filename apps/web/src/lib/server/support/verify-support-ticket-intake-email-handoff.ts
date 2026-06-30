import assert from "node:assert/strict";
import {
  renderSupportTicketIntakeEmailHandoff,
  renderSupportTicketIntakeEmailText,
  SUPPORT_TICKET_INTAKE_EMAIL_TAG,
  supportTicketIntakeEmailHandoffDownloadResponse,
  supportTicketIntakeEmailSubject,
} from "./supportTicketIntakeEmailHandoff";

process.env.CUNOTE_SUPPORT_EMAIL = "support@changupnote.com";
process.env.CUNOTE_LEGAL_OPERATOR_NAME = "검증";

const handoff = renderSupportTicketIntakeEmailHandoff({
  category: "bug",
  email: "founder@example.com",
  name: "검증 사용자",
  subject: "신청서류 초안 저장 오류",
  message: "신청서류 초안을 저장하면 버튼이 비활성화된 상태로 남아 있습니다.",
  ticketId: "queued-verify-ticket",
  hasAttachment: true,
  attachmentFilename: "error-log.txt",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
const response = supportTicketIntakeEmailHandoffDownloadResponse(handoff);
const body = await response.text();

assert.equal(handoff.filename, "창업노트-오류 신고-신청서류 초안 저장 오류-문의메일.eml");
assert.equal(handoff.fallbackFilename, "cunote-support-ticket-queued-verify-ticket.eml");
assert.equal(response.status, 200);
assert(response.headers.get("content-type")?.includes("message/rfc822"));
assert(response.headers.get("content-disposition")?.includes("attachment"));
assert(body.includes("From: =?UTF-8?B?"));
assert(body.includes("To: =?UTF-8?B?"));
assert(body.includes("<support@changupnote.com>"));
assert(body.includes("Reply-To: <founder@example.com>"));
assert(body.includes("Subject: =?UTF-8?B?"));
assert(body.includes("Content-Type: text/plain; charset=UTF-8"));
assert(body.includes("X-Cunote-Handoff: support-ticket-intake-email"));
assert(body.includes("검증 운영팀에 전달할 고객지원 문의입니다."));
assert(body.includes("접수번호: queued-verify-ticket"));
assert(body.includes("문의 유형: 오류 신고"));
assert(body.includes("첨부 파일: error-log.txt"));
assert(body.includes("신청서류 초안을 저장하면 버튼이 비활성화된 상태로 남아 있습니다."));
assert(body.includes("/support#support-ticket-form"));
assert(body.includes("첨부 원본은 이 .eml 파일에 포함되지 않으므로"));
assert.equal(SUPPORT_TICKET_INTAKE_EMAIL_TAG, "support_ticket_intake");
assert.equal(supportTicketIntakeEmailSubject({
  category: "bug",
  subject: "신청서류 초안 저장 오류",
}), "[고객지원] 오류 신고 · 신청서류 초안 저장 오류");
const text = renderSupportTicketIntakeEmailText({
  category: "bug",
  email: "founder@example.com",
  name: "검증 사용자",
  subject: "신청서류 초안 저장 오류",
  message: "신청서류 초안을 저장하면 버튼이 비활성화된 상태로 남아 있습니다.",
  ticketId: "queued-verify-ticket",
  hasAttachment: true,
  attachmentFilename: "error-log.txt",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
assert(text.includes("접수번호: queued-verify-ticket"));
assert(text.includes("문의 유형: 오류 신고"));
assert(text.includes("첨부 파일: error-log.txt"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "support_ticket_intake_email_handoff_filename",
    "support_ticket_intake_email_handoff_download_headers",
    "support_ticket_intake_email_handoff_mail_headers",
    "support_ticket_intake_email_handoff_request_context",
    "support_ticket_intake_email_handoff_attachment_note",
    "support_ticket_intake_email_handoff_service_path",
    "support_ticket_intake_email_shared_subject",
    "support_ticket_intake_email_shared_text",
  ],
}, null, 2));
