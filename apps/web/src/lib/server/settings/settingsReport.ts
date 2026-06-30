import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import type { OnboardingProgress, OnboardingProgressStep } from "@/lib/server/onboarding/onboardingProgress";
import type { WorkspaceOverview } from "@/lib/server/workspace/overview";

export interface SettingsReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export function buildSettingsReport(input: {
  progress: OnboardingProgress;
  overview: WorkspaceOverview;
  generatedAt?: Date;
}): SettingsReport {
  const generatedAt = input.generatedAt ?? new Date(input.progress.generatedAt);
  const companyName = input.overview.currentCompany.name || input.progress.companyName || "현재 회사";
  const filenameBase = sanitizeDownloadFilename(companyName, "회사설정");
  return {
    filename: `창업노트-${filenameBase}-설정리포트-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-settings-report-${dateStamp(generatedAt)}.md`,
    markdown: renderSettingsReport({
      ...input,
      generatedAt,
    }),
  };
}

export function settingsReportDownloadResponse(report: SettingsReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

export function renderSettingsReport(input: {
  progress: OnboardingProgress;
  overview: WorkspaceOverview;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date(input.progress.generatedAt);
  const { progress, overview } = input;
  const lines = [
    `# ${overview.currentCompany.name} 설정 리포트`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    `온보딩 기준 시각: ${formatDateTime(new Date(progress.generatedAt))}`,
    "",
    "> 창업노트 회사 설정, 동의, 알림, 자가신고 프로필, 워크스페이스 사용량을 운영 점검용으로 내려받은 문서입니다.",
    "",
    "## 요약",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["회사", overview.currentCompany.name],
        ["회사 상태", overview.currentCompany.verified ? "검증 완료" : "검증 필요"],
        ["회사 유형", overview.currentCompany.kind === "preliminary" ? "예비 프로필" : "운영 회사"],
        ["내 역할", roleLabel(overview.currentCompany.role)],
        ["온보딩 완료도", `${progress.completedCount}/${progress.totalCount} · ${progress.completionRatio}%`],
        ["다음 보강", progress.nextStep?.title ?? "필수 설정 완료"],
        ["플랜", `${overview.billingSubscription.planName} · ${overview.billingSubscription.statusLabel}`],
        ["좌석", `${overview.seatUsage.reservedSeats.toLocaleString("ko-KR")}/${overview.seatUsage.seatLimit.toLocaleString("ko-KR")}명`],
      ],
    ),
    "",
    "## 온보딩 단계",
    "",
    renderProgressSteps(progress.steps),
    "",
    "## 접근 가능한 회사",
    "",
    renderCompanies(overview),
    "",
    "## 워크스페이스 사용량",
    "",
    renderUsage(overview),
    "",
    "## 운영 액션",
    "",
    ...nextActions(progress, overview),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderProgressSteps(steps: OnboardingProgressStep[]): string {
  if (steps.length === 0) return "_온보딩 단계 정보가 없습니다._";
  return markdownTable(
    ["단계", "상태", "상세", "액션"],
    steps.map((step) => [
      step.title,
      stepStatusLabel(step.status),
      step.detail,
      `${step.actionLabel} (${step.actionHref})`,
    ]),
  );
}

function renderCompanies(overview: WorkspaceOverview): string {
  if (overview.companies.length === 0) return "_접근 가능한 회사 목록을 불러오지 못했습니다._";
  return markdownTable(
    ["회사", "역할", "상태", "지역", "유형"],
    overview.companies.map((company) => [
      company.name,
      roleLabel(company.role),
      company.verified ? "검증 완료" : "검증 필요",
      company.region ?? "-",
      company.kind === "preliminary" ? "예비" : "운영",
    ]),
  );
}

function renderUsage(overview: WorkspaceOverview): string {
  if (overview.usage.length === 0) return "_사용량 지표가 없습니다._";
  return markdownTable(
    ["항목", "사용", "한도", "상태", "설명"],
    overview.usage.map((metric) => [
      metric.label,
      `${metric.value.toLocaleString("ko-KR")}${metric.unit}`,
      metric.limit === null ? "무제한" : `${metric.limit.toLocaleString("ko-KR")}${metric.unit}`,
      usageToneLabel(metric.tone),
      metric.description,
    ]),
  );
}

function nextActions(progress: OnboardingProgress, overview: WorkspaceOverview): string[] {
  const actions: string[] = [];
  if (progress.nextStep) {
    actions.push(`- ${progress.nextStep.title}: ${progress.nextStep.detail}`);
  }
  if (!overview.currentCompany.verified) {
    actions.push("- 회사 소유권 검증을 완료해 지원사업 신청과 팀/청구 운영의 기준 회사를 확정한다.");
  }
  if (overview.seatUsage.limitReached) {
    actions.push("- 좌석 한도에 도달했으므로 pending 초대를 정리하거나 플랜 좌석을 조정한다.");
  }
  if (overview.usage.some((metric) => metric.tone === "warning")) {
    actions.push("- 경고 상태의 사용량 지표를 확인해 Early Access 한도 초과 전 운영 계획을 정한다.");
  }
  if (actions.length === 0) {
    actions.push("- 필수 설정은 완료되어 있으므로 새 매칭, 신청 리마인더, 초안 검토 루틴을 유지한다.");
  }
  actions.push("- 설정 변경 후 `/dashboard`와 `/applications`에서 추천/신청 준비 상태가 의도대로 갱신되는지 확인한다.");
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

function stepStatusLabel(status: OnboardingProgressStep["status"]): string {
  if (status === "complete") return "완료";
  if (status === "attention") return "확인 필요";
  return "대기";
}

function roleLabel(role: string): string {
  if (role === "owner") return "소유자";
  if (role === "admin") return "관리자";
  if (role === "member") return "멤버";
  return "뷰어";
}

function usageToneLabel(tone: WorkspaceOverview["usage"][number]["tone"]): string {
  if (tone === "success") return "정상";
  if (tone === "warning") return "주의";
  if (tone === "neutral") return "정보";
  return "활성";
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
