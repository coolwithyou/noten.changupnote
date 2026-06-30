import type { LegalReadiness, LegalReadinessItem } from "./legalReadiness";

export function renderLegalReadinessMarkdown(input: {
  readiness: LegalReadiness;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    "# 창업노트 운영 법무 readiness",
    "",
    `- 생성 시각: ${formatDateTime(generatedAt)}`,
    `- 전체 상태: ${input.readiness.statusLabel}`,
    `- 점수: ${input.readiness.score}%`,
    `- 완료 항목: ${input.readiness.configuredCount}/${input.readiness.requiredCount}`,
    `- 요약: ${input.readiness.summary}`,
    "",
    "## 누락 환경값",
    "",
    ...missingEnvLines(input.readiness),
    "",
    "## 항목별 점검",
    "",
    "| 항목 | 상태 | 설명 | 환경값 |",
    "| --- | --- | --- | --- |",
    ...input.readiness.items.map((item) => itemRow(item, input.readiness.missingKeys)),
    "",
    "## 배포 전 확인",
    "",
    ...nextActions(input.readiness),
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function missingEnvLines(readiness: LegalReadiness): string[] {
  if (readiness.missingKeys.length === 0) return ["현재 readiness 기준에서 누락된 환경값이 없습니다."];
  return unique(readiness.missingKeys).map((key) => `- ${key}`);
}

function itemRow(item: LegalReadinessItem, missingKeys: string[]): string {
  const missing = item.envKeys.filter((key) => missingKeys.includes(key));
  const envSignal = missing.length > 0
    ? `missing: ${missing.join("<br>")}`
    : `configured: ${item.envKeys.join("<br>")}`;
  return [
    escapeCell(item.label),
    item.status,
    escapeCell(item.detail),
    escapeCell(envSignal),
  ].join(" | ").replace(/^/, "| ").concat(" |");
}

function nextActions(readiness: LegalReadiness): string[] {
  if (readiness.status === "ready") {
    return [
      "- 약관/개인정보 처리방침/지원 페이지가 같은 환경값을 노출하는지 배포 환경에서 확인한다.",
      "- 신규 provider 또는 수탁사가 추가될 때 CUNOTE_PRIVACY_PROCESSORS와 CUNOTE_PRIVACY_OVERSEAS_TRANSFERS를 함께 갱신한다.",
    ];
  }
  return [
    "- 누락 환경값을 배포 환경에 설정한 뒤 /api/admin/status/legal-readiness 리포트를 다시 내려받는다.",
    "- 해당 없음인 항목도 빈 값으로 두지 말고 운영 정책상 해당 없음 문구를 환경값으로 확정한다.",
    "- 약관/개인정보 처리방침의 버전과 회원가입 동의 저장 버전이 같은지 확인한다.",
  ];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
