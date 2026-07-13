import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatchingBaselineReport, type MatchingBaselineReport } from "./lib/matching-eval.js";

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = [
  "packages/core/golden/matching/kstartup-sample-v1.json",
  "packages/core/golden/matching/kstartup-sample-v2.json",
];
const format = readFormat(process.argv.slice(2));
const report = buildMatchingBaselineReport(WORKSPACE_ROOT, FIXTURES);

console.log(format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2));

function readFormat(args: string[]): "json" | "markdown" {
  const value = args.find((arg) => arg.startsWith("--format="))?.split("=")[1] ?? "json";
  if (value !== "json" && value !== "markdown") {
    throw new Error(`Unsupported format: ${value}. Use json or markdown.`);
  }
  return value;
}

function renderMarkdown(report: MatchingBaselineReport): string {
  const lines = [
    "# 매칭 정확도 baseline v0",
    "",
    `> 생성 시각: ${report.generatedAt}`,
    `> fixture: ${report.fixtureVersions.join(", ")}`,
    "",
    "## 결과 요약",
    "",
    `- 판정쌍: ${report.metrics.total}건`,
    `- 정답 일치: ${report.metrics.correct}건`,
    `- legacy accuracy: ${percent(report.metrics.accuracy)}`,
    `- v3 호환 회사 annotation: ${report.compatibility.companyAnnotations}건`,
    `- v3 호환 고유 공고 annotation: ${report.compatibility.uniqueGrantAnnotations}건`,
    `- v3 호환 판정쌍 annotation: ${report.compatibility.eligibilityPairAnnotations}건`,
    `- 평균 조건 확인도: ${report.stratification.averageVerificationCompleteness}%`,
    `- 평균 원문 근거 커버리지: ${report.stratification.averageEvidenceCoverage}%`,
    "",
    "이 수치는 운영 정확도가 아니라 기존 회귀 fixture의 재현 기준선이다.",
    "",
    "## 클래스별 지표",
    "",
    "| 클래스 | expected | predicted | TP | precision | recall |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.metrics.byClass).map(([eligibility, metric]) =>
      `| ${eligibility} | ${metric.expected} | ${metric.predicted} | ${metric.truePositive} | ${percent(metric.precision)} | ${percent(metric.recall)} |`),
    "",
    "## 혼동행렬",
    "",
    "행은 expected, 열은 actual이다.",
    "",
    "| expected \\ actual | eligible | conditional | ineligible |",
    "|---|---:|---:|---:|",
    ...Object.entries(report.metrics.confusionMatrix).map(([expected, row]) =>
      `| ${expected} | ${row.eligible} | ${row.conditional} | ${row.ineligible} |`),
    "",
    "## Unknown 차원",
    "",
    ...renderHistogram(report.stratification.unknownDimensions),
    "",
    "## 평가 공고의 criterion 차원",
    "",
    ...renderHistogram(report.stratification.criterionDimensions),
    "",
    "## 추출 준비도",
    "",
    ...renderHistogram(report.stratification.extractionReadiness),
    "",
    "## 자격 판정 신뢰도",
    "",
    ...renderHistogram(report.stratification.eligibilityConfidence),
    "",
    "## 현재 한계",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "## 다음 확장 gate",
    "",
    "- K-Startup·기업마당 공고 총 20건의 v3 draft annotation을 먼저 채운다.",
    "- 개인·법인 회사 프로필 5건으로 seed를 확장한다.",
    "- criterion 단위 source span, hard fail, unknown 정답을 기록한다.",
    "- 최소 20%를 두 번째 reviewer가 독립 검수한다.",
    "- 공고 100건·회사 30건·판정쌍 500건 이전에는 운영 정확도를 주장하지 않는다.",
  ];
  return lines.join("\n");
}

function renderHistogram(histogram: Record<string, number>): string[] {
  const entries = Object.entries(histogram);
  if (entries.length === 0) return ["- 없음"];
  return entries.map(([label, count]) => `- ${label}: ${count}`);
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
