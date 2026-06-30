import type { SaasReadiness, SaasReadinessItem } from "./readiness";

export function renderSaasReadinessMarkdown(input: {
  readiness: SaasReadiness;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    "# 창업노트 SaaS MVP readiness",
    "",
    `- 생성 시각: ${formatDateTime(generatedAt)}`,
    `- 전체 상태: ${statusLabel(input.readiness.status)}`,
    `- 점수: ${input.readiness.score}%`,
    `- 완료 항목: ${input.readiness.readyCount}/${input.readiness.totalCount}`,
    "",
    "## 누락 요약",
    "",
    ...missingSummary(input.readiness),
    "",
  ];

  for (const section of input.readiness.sections) {
    lines.push(
      `## ${section.label}`,
      "",
      `- key: ${section.key}`,
      `- 상태: ${statusLabel(section.status)}`,
      `- 완료 항목: ${section.readyCount}/${section.totalCount}`,
      "",
      "| 항목 | 상태 | 설명 | Evidence / Missing |",
      "| --- | --- | --- | --- |",
      ...section.items.map((item) => itemRow(item)),
      "",
    );
  }

  lines.push(
    "## 다음 운영 액션",
    "",
    ...nextActions(input.readiness),
    "",
  );

  return `${lines.join("\n").trim()}\n`;
}

function missingSummary(readiness: SaasReadiness): string[] {
  if (readiness.missingKeys.length === 0) return ["현재 readiness 기준에서 누락 항목이 없습니다."];
  return readiness.missingKeys.map((key) => `- ${key}`);
}

function nextActions(readiness: SaasReadiness): string[] {
  const attentionItems = readiness.sections.flatMap((section) =>
    section.items
      .filter((item) => item.status === "attention")
      .map((item) => `${section.label}: ${item.label}`)
  );
  if (attentionItems.length === 0) {
    return [
      "- 운영 법무 환경값과 provider 설정을 실제 배포 환경에서 재확인한다.",
      "- HTTP smoke와 admin readiness를 배포 전 체크리스트에 포함한다.",
    ];
  }
  return attentionItems.map((item) => `- ${item} 보강`);
}

function itemRow(item: SaasReadinessItem): string {
  const signal = item.missing.length > 0
    ? `missing: ${item.missing.join("<br>")}`
    : `evidence: ${item.evidence.join("<br>")}`;
  return [
    escapeCell(item.label),
    statusLabel(item.status),
    escapeCell(item.description),
    escapeCell(signal),
  ].join(" | ").replace(/^/, "| ").concat(" |");
}

function statusLabel(status: "ready" | "attention"): string {
  return status === "ready" ? "ready" : "attention";
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
