import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import type { AccountSecurityStatus } from "./accountSecurityStatus";

export interface AccountSecurityReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export function buildAccountSecurityReport(input: {
  access: CompanyAccess;
  status: AccountSecurityStatus;
  generatedAt?: Date;
}): AccountSecurityReport {
  const generatedAt = input.generatedAt ?? new Date();
  const filenameBase = sanitizeDownloadFilename(
    input.status.email ?? input.status.name ?? input.access.companyId,
    "계정",
  );

  return {
    filename: `창업노트-${filenameBase}-계정보안-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-account-security-${dateStamp(generatedAt)}.md`,
    markdown: renderAccountSecurityReport({
      ...input,
      generatedAt,
    }),
  };
}

export function accountSecurityReportDownloadResponse(report: AccountSecurityReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

export function renderAccountSecurityReport(input: {
  access: CompanyAccess;
  status: AccountSecurityStatus;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const legal = getLegalConfig();
  const { access, status } = input;
  const lines = [
    `# ${status.email ?? status.name ?? "내 계정"} 보안 리포트`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트 계정의 로그인 방식, 회사 접근권한, 법무 동의 이력, 사용자가 직접 확인해야 할 운영 액션을 정리한 문서입니다.",
    "",
    "## 요약",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["로그인 방식", providerLabel(status.provider)],
        ["이메일", status.email ?? "확인 불가"],
        ["표시 이름", status.name ?? "미설정"],
        ["비밀번호", passwordCredentialLabel(status.passwordCredential)],
        ["법무 동의", legalAcceptanceLabel(status.legalAcceptance)],
        ["회사 권한", `${roleLabel(access.role)} · ${access.mode}`],
      ],
    ),
    "",
    "## 회사 접근권한",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["사용자 ID", status.userId],
        ["회사 ID", access.companyId],
        ["역할", roleLabel(access.role)],
        ["접근 모드", access.mode],
      ],
    ),
    "",
    "## 법무 동의",
    "",
    markdownTable(
      ["문서", "동의 시각", "저장 버전", "현재 버전"],
      [
        ["이용약관", formatNullableDateTime(status.termsAcceptedAt), status.termsVersion ?? "미기록", status.currentTermsVersion],
        ["개인정보 처리방침", formatNullableDateTime(status.privacyAcceptedAt), status.privacyVersion ?? "미기록", status.currentPrivacyVersion],
      ],
    ),
    "",
    "## 운영 법무 설정",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["서비스명", legal.serviceName],
        ["운영자", legal.operatorName],
        ["고객지원", legal.supportEmail],
        ["개인정보 문의", legal.privacyEmail],
        ["시행일", legal.effectiveDate],
        ["보유/삭제 요약", legal.retentionSummary],
      ],
    ),
    "",
    "## 제외 항목",
    "",
    "- 비밀번호 hash, OAuth token, refresh token, session token은 리포트와 계정 데이터 export에 포함하지 않습니다.",
    "- 다른 회사 멤버의 개인정보, 내부 관리자 메모, 비공개 고객지원 메모는 현재 사용자 권한 밖이면 포함하지 않습니다.",
    "- 세션 revoke, 기기별 접속 이력, 이메일 2FA는 auth provider 확정 이후 별도 보안 surface에서 다룹니다.",
    "",
    "## 운영 액션",
    "",
    ...nextActions({ access, status }),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function nextActions(input: { access: CompanyAccess; status: AccountSecurityStatus }): string[] {
  const actions: string[] = [];
  if (input.status.passwordCredential === "not_configured") {
    actions.push("- OAuth 전용 계정이면 이메일 비밀번호를 설정할지 검토한다.");
  }
  if (input.status.passwordCredential === "unknown") {
    actions.push("- DB 연결 또는 사용자 migration 상태를 확인해 비밀번호 설정 여부를 보강한다.");
  }
  if (input.status.legalAcceptance !== "accepted") {
    actions.push("- 회원가입/로그인 경로에서 약관과 개인정보 처리방침 동의 이력을 보강한다.");
  }
  if (input.access.role === "viewer") {
    actions.push("- 신청 준비, 팀 초대, 청구 변경이 필요하면 회사 관리자에게 권한 조정을 요청한다.");
  }
  actions.push("- 개인정보 권리 행사는 `/account`의 계정 데이터 export와 삭제 요청 흐름으로 처리한다.");
  actions.push("- 제출 전 AI 초안과 지원사업 원문은 사용자가 직접 최종 확인한다.");
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

function providerLabel(provider: AccountSecurityStatus["provider"]): string {
  if (provider === "mock") return "데모 세션";
  if (provider === "nextauth") return "이메일 또는 OAuth";
  return "세션 없음";
}

function passwordCredentialLabel(status: AccountSecurityStatus["passwordCredential"]): string {
  if (status === "configured") return "이메일 비밀번호 설정됨";
  if (status === "not_configured") return "OAuth 전용 또는 미설정";
  return "확인 불가";
}

function legalAcceptanceLabel(status: AccountSecurityStatus["legalAcceptance"]): string {
  if (status === "accepted") return "동의 기록 있음";
  if (status === "missing") return "동의 이력 보강 필요";
  return "확인 불가";
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}

function formatNullableDateTime(value: string | null): string {
  if (!value) return "기록 없음";
  return formatDateTime(new Date(value));
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
