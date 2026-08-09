import type {
  AnalysisQualityBaselineComparison,
  AnalysisQualityNodeId,
  AnalysisQualityReport,
  AnalysisQualityStatus,
} from "@/features/dev/analysis-lab/quality-contract";

const READINESS_RANK: Record<AnalysisQualityStatus, number> = {
  failed: 0,
  held: 1,
  not_evaluated: 1,
  partial: 2,
  passed: 3,
  not_applicable: 3,
};

export function compareAnalysisQualityBaselines(
  previous: AnalysisQualityReport,
  current: AnalysisQualityReport,
): AnalysisQualityBaselineComparison {
  const previousByGrant = new Map(previous.graphs.map((graph) => [graph.grantId, graph]));
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  const hardGateRegressions: AnalysisQualityBaselineComparison["hardGateRegressions"] = [];

  for (const graph of current.graphs) {
    const prior = previousByGrant.get(graph.grantId);
    if (!prior) continue;
    const delta = READINESS_RANK[graph.analysisReadiness] - READINESS_RANK[prior.analysisReadiness];
    if (delta > 0) improved += 1;
    else if (delta < 0) regressed += 1;
    else unchanged += 1;
    if (
      (prior.analysisReadiness === "passed" || prior.analysisReadiness === "partial")
      && (graph.analysisReadiness === "held" || graph.analysisReadiness === "failed")
    ) {
      hardGateRegressions.push({
        grantId: graph.grantId,
        title: graph.title,
        previous: prior.analysisReadiness,
        current: graph.analysisReadiness,
      });
    }
  }

  const previousBlockers = new Map(previous.summary.blockers.map((item) => [item.nodeId, item]));
  const currentBlockers = new Map(current.summary.blockers.map((item) => [item.nodeId, item]));
  const nodeIds = new Set<AnalysisQualityNodeId>([...previousBlockers.keys(), ...currentBlockers.keys()]);
  const blockerDeltas = [...nodeIds].map((nodeId) => {
    const prior = previousBlockers.get(nodeId);
    const next = currentBlockers.get(nodeId);
    const previousCount = prior?.count ?? 0;
    const currentCount = next?.count ?? 0;
    return {
      nodeId,
      label: next?.label ?? prior?.label ?? nodeId,
      previous: previousCount,
      current: currentCount,
      delta: currentCount - previousCount,
    };
  }).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.label.localeCompare(right.label));

  return {
    policyVersion: current.policyVersion,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    comparableGrants: improved + regressed + unchanged,
    improved,
    regressed,
    unchanged,
    hardGateRegressions,
    blockerDeltas,
  };
}

export function formatAnalysisQualityReport(report: AnalysisQualityReport): string {
  const { summary } = report;
  const lines = [
    `품질 기준선 ${summary.total}/${report.requestedLimit}건 · ${report.policyVersion}`,
    `분석 준비도: 완료 ${summary.analysis.passed} · 부분 완료 ${summary.analysis.partial} · 보류 ${summary.analysis.held} · 실패 ${summary.analysis.failed} · 미검증 ${summary.analysis.not_evaluated}`,
    `딥분석: 완료 ${summary.deepAnalysis.passed} · 부분 ${summary.deepAnalysis.partial} · 보류 ${summary.deepAnalysis.held} · 실패 ${summary.deepAnalysis.failed}`,
    `Kordoc: 완료 ${summary.application.passed} · 부분 ${summary.application.partial} · 보류 ${summary.application.held} · 실패 ${summary.application.failed} · 미검증 ${summary.application.not_evaluated} · 대상 아님 ${summary.application.not_applicable}`,
    `제품 증거: 완료 ${summary.product.passed} · 미검증 ${summary.product.not_evaluated}`,
  ];
  if (summary.total < report.requestedLimit) {
    lines.push(`주의: 현행 정책 최신 런이 ${summary.total}건뿐이라 요청한 ${report.requestedLimit}건 기준선을 채우지 못했습니다.`);
  }
  if (summary.blockers.length > 0) {
    lines.push("차단 단계:");
    for (const blocker of summary.blockers) lines.push(`- ${blocker.label}: ${blocker.count}건`);
  }
  return lines.join("\n");
}

export function formatAnalysisQualityComparison(comparison: AnalysisQualityBaselineComparison): string {
  const lines = [
    `비교 가능 ${comparison.comparableGrants}건 · 개선 ${comparison.improved} · 악화 ${comparison.regressed} · 동일 ${comparison.unchanged}`,
    `하드 게이트 회귀 ${comparison.hardGateRegressions.length}건`,
  ];
  const changedBlockers = comparison.blockerDeltas.filter((item) => item.delta !== 0);
  if (changedBlockers.length > 0) {
    lines.push("차단 사유 변화:");
    for (const item of changedBlockers) {
      lines.push(`- ${item.label}: ${item.previous} → ${item.current} (${item.delta > 0 ? "+" : ""}${item.delta})`);
    }
  }
  return lines.join("\n");
}
