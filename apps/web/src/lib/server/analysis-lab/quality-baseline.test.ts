import assert from "node:assert/strict";
import type { AnalysisQualityGraph, AnalysisQualityReport, AnalysisQualityStatus } from "@/features/dev/analysis-lab/quality-contract";
import { ANALYSIS_QUALITY_POLICY_VERSION, emptyQualityStatusCounts } from "@/features/dev/analysis-lab/quality-contract";
import { compareAnalysisQualityBaselines, formatAnalysisQualityReport } from "./quality-baseline";

function graph(grantId: string, status: AnalysisQualityStatus): AnalysisQualityGraph {
  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    grantId,
    runId: `run-${grantId}`,
    title: grantId,
    evaluatedAt: "2026-08-09T00:00:00.000Z",
    analysisReadiness: status,
    productReadiness: "not_evaluated",
    lanes: { deep_analysis: status, application: "passed", product: "not_evaluated" },
    nodes: [],
    edges: [],
    metrics: {
      criteria: 0,
      groundedCriteria: 0,
      assessedAxes: 22,
      ambiguousAxes: 0,
      inputMissingAxes: 0,
      applicationDocuments: 0,
      fieldCandidates: 0,
      acceptedFields: 0,
      unresolvedFields: 0,
      requiredUnresolvedFields: 0,
    },
  };
}

function report(
  generatedAt: string,
  graphs: AnalysisQualityGraph[],
  blockers: AnalysisQualityReport["summary"]["blockers"],
): AnalysisQualityReport {
  const analysis = emptyQualityStatusCounts();
  for (const item of graphs) analysis[item.analysisReadiness] += 1;
  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    generatedAt,
    selection: "latest-current-run-per-grant",
    requestedLimit: 30,
    summary: {
      total: graphs.length,
      analysis,
      deepAnalysis: { ...analysis },
      application: emptyQualityStatusCounts(),
      product: emptyQualityStatusCounts(),
      blockers,
    },
    graphs,
  };
}

{
  const previous = report(
    "2026-08-08T00:00:00.000Z",
    [graph("a", "held"), graph("b", "passed"), graph("c", "partial")],
    [{ nodeId: "independent_review", label: "독립 AI 검수", count: 2 }],
  );
  const current = report(
    "2026-08-09T00:00:00.000Z",
    [graph("a", "passed"), graph("b", "held"), graph("c", "partial"), graph("new", "passed")],
    [{ nodeId: "independent_review", label: "독립 AI 검수", count: 1 }],
  );
  const comparison = compareAnalysisQualityBaselines(previous, current);
  assert.deepEqual(
    {
      comparable: comparison.comparableGrants,
      improved: comparison.improved,
      regressed: comparison.regressed,
      unchanged: comparison.unchanged,
      hard: comparison.hardGateRegressions.map((item) => item.grantId),
    },
    { comparable: 3, improved: 1, regressed: 1, unchanged: 1, hard: ["b"] },
  );
  assert.equal(comparison.blockerDeltas[0]?.delta, -1);
  console.log("✅ 품질 기준선 비교 — 개선·회귀·하드 게이트 악화 분리");
}

{
  const current = report("2026-08-09T00:00:00.000Z", [graph("a", "passed")], []);
  const output = formatAnalysisQualityReport(current);
  assert.match(output, /1\/30건/);
  assert.match(output, /기준선을 채우지 못했습니다/);
  console.log("✅ 품질 기준선 출력 — 요청 표본 미달을 숨기지 않음");
}
