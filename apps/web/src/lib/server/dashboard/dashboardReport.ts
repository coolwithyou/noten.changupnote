import type { ActionQueueItem, DashboardResult, MatchCard } from "@cunote/contracts";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export interface DashboardReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export function buildDashboardReport(input: {
  dashboard: DashboardResult;
  generatedAt?: Date;
}): DashboardReport {
  const generatedAt = input.generatedAt ?? new Date();
  const stamp = dateStamp(generatedAt);
  return {
    filename: `창업노트-기회맵-${stamp}.md`,
    fallbackFilename: `cunote-dashboard-report-${stamp}.md`,
    markdown: renderDashboardReport({
      ...input,
      generatedAt,
    }),
  };
}

export function dashboardReportDownloadResponse(report: DashboardReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

export function renderDashboardReport(input: {
  dashboard: DashboardResult;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const { dashboard } = input;
  const lines = [
    `# ${companyLabel(dashboard)} 기회 맵 리포트`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트 대시보드의 현재 적격/확인 필요 공고, 우선 액션, 다음 보강 질문을 팀 점검용으로 내려받은 문서입니다.",
    "",
    "## 요약",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["지금 적격", `${dashboard.counts.eligible.toLocaleString("ko-KR")}건`],
        ["확인 필요", `${dashboard.counts.conditional.toLocaleString("ko-KR")}건`],
        ["부적격", `${dashboard.counts.ineligible.toLocaleString("ko-KR")}건`],
        ["마감 임박", `${dashboard.counts.deadlineSoon.toLocaleString("ko-KR")}건`],
        ["룰셋", dashboard.rulesetVer],
        ["스코어링", dashboard.scoringVer],
      ],
    ),
    "",
    "## 회사 기준",
    "",
    markdownTable(
      ["항목", "값"],
      [
        ["지역", dashboard.company.region ?? "미확인"],
        ["규모", dashboard.company.size ?? "미확인"],
        ["업력", dashboard.company.bizAgeMonths === null ? "미확인" : `${dashboard.company.bizAgeMonths.toLocaleString("ko-KR")}개월`],
        ["업종", dashboard.company.industries.length > 0 ? dashboard.company.industries.join(", ") : "미확인"],
      ],
    ),
    "",
    "## 상위 기회",
    "",
    renderMatches(dashboard.matches),
    "",
    "## 우선 액션",
    "",
    renderActions(dashboard.actionQueue),
    "",
    "## 다음 보강 질문",
    "",
    renderNextQuestion(dashboard),
    "",
    "## 운영 액션",
    "",
    ...nextActions(dashboard),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderMatches(matches: MatchCard[]): string {
  const rows = matches
    .filter((match) => match.eligibility !== "ineligible")
    .slice(0, 12)
    .map((match) => [
      eligibilityLabel(match.eligibility),
      match.title,
      match.agency ?? "-",
      `${match.fitScore.toLocaleString("ko-KR")}점`,
      supportAmountLabel(match.supportAmount),
      dDayLabel(match.dDay),
      match.detailUrl ?? `/grants/${encodeURIComponent(match.grantId)}`,
    ]);
  if (rows.length === 0) return "_현재 적격 또는 확인 필요 기회가 없습니다._";
  return markdownTable(["상태", "공고", "기관", "적합도", "지원", "마감", "링크"], rows);
}

function renderActions(actions: ActionQueueItem[]): string {
  if (actions.length === 0) return "_현재 우선 액션이 없습니다._";
  return markdownTable(
    ["우선순위", "액션", "이유", "영향 공고", "예상 지원", "노력"],
    actions.map((action) => [
      urgencyLabel(action.urgency),
      action.title,
      action.reason,
      `${action.affectedGrantCount.toLocaleString("ko-KR")}건`,
      formatKrw(action.leverageAmount),
      effortLabel(action.effort),
    ]),
  );
}

function renderNextQuestion(dashboard: DashboardResult): string {
  const question = dashboard.nextQuestion;
  if (!question) return "_현재 추가로 물어볼 보강 질문이 없습니다._";
  return markdownTable(
    ["항목", "값"],
    [
      ["질문", question.prompt],
      ["영향 공고", `${question.affectedGrantCount.toLocaleString("ko-KR")}건`],
      ["입력 방식", question.inputType],
      ["설명", question.framing],
      ["선택지", question.options?.join(", ") || "-"],
    ],
  );
}

function nextActions(dashboard: DashboardResult): string[] {
  const actions: string[] = [];
  if (dashboard.counts.eligible > 0) {
    actions.push("- 적격 공고는 `/applications`에서 저장, 담당자, 리마인더를 지정한다.");
  }
  if (dashboard.nextQuestion) {
    actions.push(`- ${dashboard.nextQuestion.prompt} 이 질문을 답해 조건부 공고 ${dashboard.nextQuestion.affectedGrantCount.toLocaleString("ko-KR")}건을 확정 또는 제외한다.`);
  }
  if (dashboard.counts.deadlineSoon > 0) {
    actions.push("- 마감 임박 공고는 신청서류 준비 상태와 캘린더 export를 먼저 확인한다.");
  }
  if (dashboard.actionQueue.some((action) => action.kind === "enrich")) {
    actions.push("- 회사 기본정보 보강 액션은 `/settings`의 정보 동의와 사업자 정보 보강에서 처리한다.");
  }
  if (actions.length === 0) {
    actions.push("- 현재는 새 매칭 또는 보강 질문을 기다리며 알림센터 상태를 유지한다.");
  }
  actions.push("- 부적격 공고는 숨기지 말고 주요 탈락 사유가 회사 상태 변화로 해소될 수 있는지 정기 점검한다.");
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

function companyLabel(dashboard: DashboardResult): string {
  const parts = [
    dashboard.company.name,
    dashboard.company.region,
    dashboard.company.size,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "현재 회사";
}

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}

function supportAmountLabel(amount: MatchCard["supportAmount"]): string {
  if (amount.label) return amount.label;
  if (typeof amount.max === "number") return formatKrw(amount.max);
  if (typeof amount.min === "number") return `${formatKrw(amount.min)} 이상`;
  return "미확인";
}

function formatKrw(value: number): string {
  if (value <= 0) return "미확인";
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000).toLocaleString("ko-KR")}억원`;
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
  return `${value.toLocaleString("ko-KR")}원`;
}

function dDayLabel(dDay: number | null): string {
  if (dDay === null) return "미확인";
  if (dDay < 0) return `${Math.abs(dDay)}일 지남`;
  if (dDay === 0) return "오늘";
  return `D-${dDay}`;
}

function urgencyLabel(value: ActionQueueItem["urgency"]): string {
  if (value === "high") return "높음";
  if (value === "medium") return "중간";
  return "낮음";
}

function effortLabel(value: ActionQueueItem["effort"]): string {
  if (value === "quick") return "빠름";
  if (value === "medium") return "보통";
  return "긴 작업";
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
