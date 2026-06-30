import assert from "node:assert/strict";
import {
  billingPlanRequestEmailHandoffDownloadResponse,
  renderBillingPlanRequestEmailHandoff,
} from "./planRequestEmailHandoff";
import type { BillingPlanRequestDetail } from "./planRequestHistory";

process.env.CUNOTE_BILLING_EMAIL = "billing@changupnote.com";
process.env.CUNOTE_BILLING_CONTACT_NAME = "검증 청구팀";

const request: BillingPlanRequestDetail = {
  id: "00000000-0000-4000-8000-000000000301",
  status: "open",
  priority: "normal",
  desiredPlan: "team",
  billingCycle: "annual",
  seatCount: 8,
  email: "buyer@example.com",
  name: "검증 구매자",
  subject: "[플랜 전환] Team 8석",
  message: [
    "희망 플랜: Team",
    "예상 좌석: 8석",
    "청구 주기: 연간",
    "",
    "세금계산서 발행과 연간 계약서를 같이 받고 싶습니다.",
  ].join("\n"),
  messagePreview: "Team 8석 연간 전환 요청",
  requestedAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

const handoff = renderBillingPlanRequestEmailHandoff({
  request,
  companyName: "검증 회사",
  currentPlanName: "Early Access",
  seatUsageLabel: "3명 사용 / 8명 한도",
  senderName: "대표 사용자",
  senderEmail: "owner@example.com",
  recipientEmail: "billing@changupnote.com",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
const response = billingPlanRequestEmailHandoffDownloadResponse(handoff);
const body = await response.text();

assert.equal(handoff.filename, "창업노트-검증 회사-Team-00000000-전환요청메일.eml");
assert.equal(handoff.fallbackFilename, "cunote-billing-plan-request-00000000.eml");
assert.equal(response.status, 200);
assert(response.headers.get("content-type")?.includes("message/rfc822"));
assert(response.headers.get("content-disposition")?.includes("attachment"));
assert(body.includes("From: =?UTF-8?B?"));
assert(body.includes("To: =?UTF-8?B?"));
assert(body.includes("<billing@changupnote.com>"));
assert(body.includes("Reply-To: <buyer@example.com>"));
assert(body.includes("Subject: =?UTF-8?B?"));
assert(body.includes("Content-Type: text/plain; charset=UTF-8"));
assert(body.includes("X-Cunote-Handoff: billing-plan-request-email"));
assert(body.includes("검증 회사 워크스페이스의 플랜 전환 상담 요청입니다."));
assert(body.includes(`요청 번호: ${request.id}`));
assert(body.includes("현재 플랜: Early Access"));
assert(body.includes("현재 좌석: 3명 사용 / 8명 한도"));
assert(body.includes("희망 플랜: Team"));
assert(body.includes("희망 좌석: 8석"));
assert(body.includes("희망 청구 주기: 연간"));
assert(body.includes("세금계산서 발행과 연간 계약서를 같이 받고 싶습니다."));
assert(body.includes("/billing"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "billing_plan_request_email_handoff_filename",
    "billing_plan_request_email_handoff_download_headers",
    "billing_plan_request_email_handoff_mail_headers",
    "billing_plan_request_email_handoff_request_context",
    "billing_plan_request_email_handoff_contract_context",
    "billing_plan_request_email_handoff_service_path",
  ],
}, null, 2));
