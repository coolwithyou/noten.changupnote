import assert from "node:assert/strict";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";
import { buildTeamOperationsReport, renderTeamOperationsReport } from "./teamOperationsReport";

const overview: WorkspaceOverview = {
  generatedAt: "2026-06-30T00:00:00.000Z",
  currentCompany: {
    id: "00000000-0000-4000-8000-000000000101",
    name: "검증 주식회사",
    role: "owner",
    verified: false,
    bizNoMasked: "123-**-67***",
    region: "서울",
    kind: "active",
  },
  companies: [],
  members: [
    {
      userId: "00000000-0000-4000-8000-000000000201",
      name: "대표 사용자",
      email: "owner@example.test",
      role: "owner",
      joinedAt: "2026-06-01T00:00:00.000Z",
      currentUser: true,
    },
    {
      userId: "00000000-0000-4000-8000-000000000202",
      name: "운영 담당",
      email: "ops@example.test",
      role: "admin",
      joinedAt: "2026-06-02T00:00:00.000Z",
      currentUser: false,
    },
  ],
  invitations: [
    {
      id: "00000000-0000-4000-8000-000000000301",
      email: "new@example.test",
      role: "member",
      status: "pending",
      expiresAt: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-06-30T00:00:00.000Z",
      inviteUrl: null,
      persisted: true,
      emailDelivery: {
        provider: "none",
        configured: false,
        status: "skipped",
      },
    },
  ],
  roleChangeEvents: [
    {
      id: "00000000-0000-4000-8000-000000000401",
      companyId: "00000000-0000-4000-8000-000000000101",
      targetUserId: "00000000-0000-4000-8000-000000000202",
      targetName: "운영 담당",
      targetEmail: "ops@example.test",
      previousRole: "member",
      nextRole: "admin",
      actorUserId: "00000000-0000-4000-8000-000000000201",
      actorName: "대표 사용자",
      actorEmail: "owner@example.test",
      source: "team_management",
      createdAt: "2026-06-29T00:00:00.000Z",
      persisted: true,
    },
  ],
  seatUsage: {
    activeSeats: 2,
    pendingInvitations: 1,
    reservedSeats: 3,
    seatLimit: 3,
    availableSeats: 0,
    limitReached: true,
  },
  usage: [],
  plan: {
    planName: "Team",
    status: "검토중",
    priceLabel: "상담 후 확정",
    renewalLabel: "운영팀 확인",
    included: [],
    nextSteps: [],
  },
  billingSubscription: {
    source: "database",
    sourceLabel: "저장됨",
    persisted: true,
    provider: "manual",
    providerLabel: "수동",
    providerConfigured: false,
    status: "manual_review",
    statusLabel: "검토중",
    planCode: "team",
    planName: "Team",
    priceLabel: "상담 후 확정",
    renewalLabel: "운영팀 확인",
    seatLimit: 3,
    included: [],
    nextSteps: [],
    paymentMethodLabel: "미연동",
    invoiceStatusLabel: "미연동",
    providerPortalUrl: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    updatedAt: "2026-06-30T00:00:00.000Z",
    automation: {
      autoBillingEnabled: false,
      invoicesEnabled: false,
      paymentMethodManaged: false,
    },
  },
};

const markdown = renderTeamOperationsReport({
  overview,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});
const report = buildTeamOperationsReport({
  overview,
  generatedAt: new Date("2026-06-30T00:00:00.000Z"),
});

assert(markdown.includes("# 검증 주식회사 팀 운영 리포트"));
assert(markdown.includes("## 요약"));
assert(markdown.includes("| 좌석 | 3/3명 |"));
assert(markdown.includes("## 멤버"));
assert(markdown.includes("운영 담당"));
assert(markdown.includes("## 초대 이력"));
assert(markdown.includes("new@example.test"));
assert(markdown.includes("## 권한 변경 이력"));
assert(markdown.includes("멤버 -> 관리자"));
assert(markdown.includes("좌석 한도에 도달"));
assert.equal(report.fallbackFilename, "cunote-team-operations-2026-06-30.md");
assert(report.filename.includes("창업노트-검증 주식회사-팀운영-2026-06-30.md"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "team_operations_report_heading",
    "team_operations_report_summary",
    "team_operations_report_members",
    "team_operations_report_invitations",
    "team_operations_report_role_history",
    "team_operations_report_next_actions",
    "team_operations_report_filename",
  ],
}, null, 2));
