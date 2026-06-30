import assert from "node:assert/strict";
import {
  renderTeamInvitationEmailHandoff,
  renderTeamInvitationEmailText,
  TEAM_INVITATION_EMAIL_TAG,
  teamInvitationEmailSubject,
} from "./teamInvitationEmailHandoff";

process.env.CUNOTE_SUPPORT_EMAIL = "support@changupnote.com";

const handoff = renderTeamInvitationEmailHandoff({
  email: "member@example.com",
  role: "admin",
  companyName: "검증 회사",
  inviteUrl: "https://changupnote.com/team/invite/token-verify-1234567890",
  expiresAt: "2026-07-14T00:00:00.000Z",
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});

assert.equal(handoff.filename, "창업노트-검증 회사-팀초대.eml");
assert.equal(handoff.fallbackFilename, "cunote-team-invitation.eml");
assert(handoff.eml.includes("From: =?UTF-8?B?"));
assert(handoff.eml.includes("To: <member@example.com>"));
assert(handoff.eml.includes("Subject: =?UTF-8?B?"));
assert(handoff.eml.includes("Content-Type: text/plain; charset=UTF-8"));
assert(handoff.eml.includes("X-Cunote-Handoff: team-invitation-email"));
assert(handoff.eml.includes("검증 회사 워크스페이스에 관리자 역할로 초대되었습니다."));
assert(handoff.eml.includes("https://changupnote.com/team/invite/token-verify-1234567890"));
assert(handoff.eml.includes("초대 만료:"));
assert.equal(teamInvitationEmailSubject("검증 회사"), "검증 회사 창업노트 초대");
assert.equal(TEAM_INVITATION_EMAIL_TAG, "team_invitation");
const text = renderTeamInvitationEmailText({
  email: "member@example.com",
  role: "admin",
  companyName: "검증 회사",
  inviteUrl: "https://changupnote.com/team/invite/token-verify-1234567890",
  expiresAt: "2026-07-14T00:00:00.000Z",
});
assert(text.includes("검증 회사 워크스페이스에 관리자 역할로 초대되었습니다."));
assert(text.includes("https://changupnote.com/team/invite/token-verify-1234567890"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "team_invitation_email_handoff_filename",
    "team_invitation_email_handoff_headers",
    "team_invitation_email_handoff_role_copy",
    "team_invitation_email_handoff_invite_url",
    "team_invitation_email_handoff_expiry",
    "team_invitation_email_shared_subject",
    "team_invitation_email_shared_text",
  ],
}, null, 2));
