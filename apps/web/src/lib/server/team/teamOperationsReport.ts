import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";

export interface TeamOperationsReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export function buildTeamOperationsReport(input: {
  overview: WorkspaceOverview;
  generatedAt?: Date;
}): TeamOperationsReport {
  const generatedAt = input.generatedAt ?? new Date();
  const companyName = input.overview.currentCompany.name || "현재 회사";
  const filenameBase = sanitizeDownloadFilename(companyName, "워크스페이스");
  return {
    filename: `창업노트-${filenameBase}-팀운영-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-team-operations-${dateStamp(generatedAt)}.md`,
    markdown: renderTeamOperationsReport({
      overview: input.overview,
      generatedAt,
    }),
  };
}

export function teamOperationsReportDownloadResponse(report: TeamOperationsReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

export function renderTeamOperationsReport(input: {
  overview: WorkspaceOverview;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const { overview } = input;
  const lines = [
    `# ${overview.currentCompany.name} 팀 운영 리포트`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트 워크스페이스의 현재 멤버, 좌석, 초대, 권한 변경 이력을 운영 점검용으로 내려받은 문서입니다.",
    "",
    "## 요약",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["회사", overview.currentCompany.name],
        ["회사 상태", overview.currentCompany.verified ? "검증 완료" : "검증 필요"],
        ["내 역할", roleLabel(overview.currentCompany.role)],
        ["플랜", `${overview.billingSubscription.planName} · ${overview.billingSubscription.statusLabel}`],
        ["좌석", `${overview.seatUsage.reservedSeats.toLocaleString("ko-KR")}/${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명`],
        ["활성 멤버", `${overview.seatUsage.activeSeats.toLocaleString("ko-KR")}명`],
        ["대기 초대", `${overview.seatUsage.pendingInvitations.toLocaleString("ko-KR")}명`],
        ["남은 좌석", `${overview.seatUsage.availableSeats.toLocaleString("ko-KR")}명`],
      ],
    ),
    "",
    "## 멤버",
    "",
    renderMembers(overview),
    "",
    "## 초대 이력",
    "",
    renderInvitations(overview),
    "",
    "## 권한 변경 이력",
    "",
    renderRoleEvents(overview),
    "",
    "## 운영 액션",
    "",
    ...nextActions(overview),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderMembers(overview: WorkspaceOverview): string {
  if (overview.members.length === 0) return "_현재 회사에 연결된 멤버가 없습니다._";
  return markdownTable(
    ["이름", "이메일", "역할", "가입일", "현재 사용자"],
    overview.members.map((member) => [
      member.name,
      member.email ?? "-",
      roleLabel(member.role),
      member.joinedAt ? formatDate(member.joinedAt) : "-",
      member.currentUser ? "예" : "아니오",
    ]),
  );
}

function renderInvitations(overview: WorkspaceOverview): string {
  if (overview.invitations.length === 0) return "_최근 초대 이력이 없습니다._";
  return markdownTable(
    ["이메일", "역할", "상태", "만료일", "저장 상태"],
    overview.invitations.map((invitation) => [
      invitation.email,
      roleLabel(invitation.role),
      invitationStatusLabel(invitation.status),
      formatDate(invitation.expiresAt),
      invitation.persisted ? "저장됨" : "임시",
    ]),
  );
}

function renderRoleEvents(overview: WorkspaceOverview): string {
  if (overview.roleChangeEvents.length === 0) return "_최근 권한 변경 이력이 없습니다._";
  return markdownTable(
    ["대상", "변경", "실행자", "시각"],
    overview.roleChangeEvents.map((event) => [
      event.targetName,
      `${roleLabel(event.previousRole)} -> ${roleLabel(event.nextRole)}`,
      event.actorName,
      formatDateTime(new Date(event.createdAt)),
    ]),
  );
}

function nextActions(overview: WorkspaceOverview): string[] {
  const actions: string[] = [];
  if (!overview.currentCompany.verified) {
    actions.push("- 회사 검증을 완료해 팀/청구/지원사업 신청 이력의 기준 회사를 확정한다.");
  }
  if (overview.seatUsage.limitReached) {
    actions.push("- 좌석 한도에 도달했으므로 불필요한 pending 초대를 철회하거나 플랜 좌석을 조정한다.");
  }
  if (overview.invitations.some((invitation) => invitation.status === "pending")) {
    actions.push("- 대기 중인 초대는 만료 전 수락 여부를 확인하고, 필요하면 재발행 또는 철회한다.");
  }
  if (overview.roleChangeEvents.length === 0 && overview.members.length > 1) {
    actions.push("- 권한 변경 이력이 없으므로 관리자/멤버/뷰어 역할이 현재 운영 책임과 맞는지 점검한다.");
  }
  if (actions.length === 0) {
    actions.push("- 새 멤버를 초대하기 전 남은 좌석과 역할 범위를 먼저 확인한다.");
  }
  actions.push("- 소유자 권한 변경, 결제 좌석 증설, 보안 감사 로그 장기 보관은 운영 정책에 맞춰 별도 승인한다.");
  return actions;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}

function invitationStatusLabel(status: string): string {
  if (status === "accepted") return "수락";
  if (status === "revoked") return "철회";
  if (status === "expired") return "만료";
  return "대기";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10);
}
