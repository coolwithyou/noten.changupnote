import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { loadServiceDashboard } from "@/lib/server/serviceData";
import {
  buildApplicationPipeline,
  type ApplicationPipelineItem,
  type ApplicationPipelineResult,
  type ApplicationStage,
} from "./pipeline";

export interface ApplicationPipelineReport {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

const STAGE_ORDER: ApplicationStage[] = [
  "preparing",
  "saved",
  "recommended",
  "submitted",
  "selected",
  "rejected",
  "blocked",
  "dismissed",
];

export async function buildApplicationPipelineReport(input: {
  access: CompanyAccess;
  asOf?: Date;
}): Promise<ApplicationPipelineReport> {
  const generatedAt = input.asOf ?? new Date();
  const dashboard = await loadServiceDashboard({
    companyId: input.access.companyId,
    userId: input.access.userId,
    limit: 80,
    writeMatchStates: false,
  });
  const pipeline = await buildApplicationPipeline({
    access: input.access,
    matches: dashboard.matches,
    now: generatedAt,
  });
  const companyName = dashboard.company.name ?? "현재 회사";
  const filenameBase = sanitizeDownloadFilename(companyName, "워크스페이스");

  return {
    filename: `창업노트-${filenameBase}-신청파이프라인-${dateStamp(generatedAt)}.md`,
    fallbackFilename: `cunote-application-pipeline-${dateStamp(generatedAt)}.md`,
    markdown: renderApplicationPipelineReport({
      companyName,
      pipeline,
      generatedAt,
    }),
  };
}

export function applicationPipelineReportDownloadResponse(report: ApplicationPipelineReport): Response {
  return markdownDownloadResponse({
    markdown: report.markdown,
    filename: report.filename,
    fallbackFilename: report.fallbackFilename,
  });
}

function renderApplicationPipelineReport(input: {
  companyName: string;
  pipeline: ApplicationPipelineResult;
  generatedAt: Date;
}): string {
  const { companyName, pipeline, generatedAt } = input;
  const lines = [
    `# ${companyName} 신청 파이프라인 리포트`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트 신청 보드의 현재 상태를 팀 내부 점검용으로 내려받은 문서입니다. 실제 제출 여부와 선정 결과는 각 지원사업 공식 포털과 담당 기관 공지를 기준으로 최종 확인하세요.",
    "",
    "## 상태 요약",
    "",
    markdownTable(
      ["단계", "건수"],
      STAGE_ORDER.map((stage) => [stageLabel(stage), `${pipeline.stats[stage].toLocaleString("ko-KR")}건`]),
    ),
    "",
    "## 다음 액션",
    "",
    renderNextActions(pipeline.items),
    "",
    "## 파이프라인 상세",
    "",
    renderStageSections(pipeline.items),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderNextActions(items: ApplicationPipelineItem[]): string {
  const actionable = items
    .filter((item) => item.stage !== "dismissed")
    .slice(0, 12);
  if (actionable.length === 0) {
    return "_현재 점검할 신청 항목이 없습니다._";
  }

  return markdownTable(
    ["단계", "공고", "마감", "다음 액션"],
    actionable.map((item) => [
      item.stageLabel,
      item.title,
      formatDday(item.dDay),
      item.nextAction,
    ]),
  );
}

function renderStageSections(items: ApplicationPipelineItem[]): string {
  const sections = STAGE_ORDER.map((stage) => {
    const stageItems = items.filter((item) => item.stage === stage);
    return [
      `### ${stageLabel(stage)}`,
      "",
      stageItems.length === 0
        ? "_해당 단계의 공고가 없습니다._"
        : markdownTable(
          ["공고", "기관", "마감", "지원", "초안", "담당", "리마인더", "메모"],
          stageItems.map((item) => [
            item.title,
            item.agency ?? "기관 확인 필요",
            formatDday(item.dDay),
            item.supportLabel,
            `${item.reviewedDraftCount}/${item.draftCount}`,
            item.assigneeName ?? "-",
            item.reminderAt ?? "-",
            item.outcomeNote ?? "-",
          ]),
        ),
    ].join("\n");
  });
  return sections.join("\n\n");
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function stageLabel(stage: ApplicationStage): string {
  if (stage === "recommended") return "추천";
  if (stage === "saved") return "저장";
  if (stage === "preparing") return "서류 준비";
  if (stage === "submitted") return "제출 완료";
  if (stage === "selected") return "선정";
  if (stage === "rejected") return "탈락";
  if (stage === "blocked") return "신청 막힘";
  return "보류";
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감";
  if (value === 0) return "D-Day";
  return `D-${value}`;
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
