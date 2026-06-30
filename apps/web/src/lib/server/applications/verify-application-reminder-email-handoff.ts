import assert from "node:assert/strict";
import type { ApplicationPipelineItem } from "./pipeline";
import { renderApplicationReminderEmailHandoff } from "./applicationReminderEmailHandoff";

process.env.CUNOTE_APPLICATIONS_EMAIL = "applications@changupnote.com";

const item: ApplicationPipelineItem = {
  grantId: "kstartup:verify-application-reminder",
  title: "2026 해양수산분야 오픈이노베이션",
  agency: "오픈이노베이션3팀",
  fitScore: 87,
  eligibility: "eligible",
  dDay: 7,
  applyEnd: "2026-07-07",
  supportLabel: "금액 미확인",
  stage: "submitted",
  stageLabel: "제출",
  lastActionAt: "2026-06-30T00:00:00.000Z",
  draftCount: 2,
  reviewedDraftCount: 1,
  warningCount: 0,
  detailHref: "/grants/kstartup%3Averify-application-reminder",
  nextAction: "결과 발표와 후속 증빙 일정을 기록하세요.",
  assigneeName: "김담당",
  reminderAt: "2026-07-10",
  outcomeNote: "보완 요청 가능성 확인",
};

const handoff = renderApplicationReminderEmailHandoff({
  item,
  companyName: "검증 회사",
  recipientEmail: "owner@example.com",
  detailUrl: "https://changupnote.com/grants/kstartup%3Averify-application-reminder",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});

assert.equal(handoff.filename, "창업노트-2026 해양수산분야 오픈이노베이션-신청리마인더.eml");
assert.equal(handoff.fallbackFilename, "cunote-application-reminder-kstartup-verify-application-reminder.eml");
assert(handoff.eml.includes("From: =?UTF-8?B?"));
assert(handoff.eml.includes("To: <owner@example.com>"));
assert(handoff.eml.includes("Subject: =?UTF-8?B?"));
assert(handoff.eml.includes("Content-Type: text/plain; charset=UTF-8"));
assert(handoff.eml.includes("X-Cunote-Handoff: application-reminder-email"));
assert(handoff.eml.includes("검증 회사의 지원사업 신청 후속 확인 메일입니다."));
assert(handoff.eml.includes("현재 단계: 제출"));
assert(handoff.eml.includes("다음 액션: 결과 발표와 후속 증빙 일정을 기록하세요."));
assert(handoff.eml.includes("담당자: 김담당"));
assert(handoff.eml.includes("내부 리마인더:"));
assert(handoff.eml.includes("https://changupnote.com/grants/kstartup%3Averify-application-reminder"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "application_reminder_email_handoff_filename",
    "application_reminder_email_handoff_headers",
    "application_reminder_email_handoff_stage",
    "application_reminder_email_handoff_assignee",
    "application_reminder_email_handoff_detail_link",
  ],
}, null, 2));
