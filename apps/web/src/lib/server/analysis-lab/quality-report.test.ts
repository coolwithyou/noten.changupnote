import assert from "node:assert/strict";
import {
  ANALYSIS_QUALITY_POLICY_VERSION,
  type AnalysisQualityGraph,
  type AnalysisQualityStatus,
} from "@/lib/server/analysis-lab/quality-contract";
import { buildAnalysisQualityReport } from "./quality-report";

function graphFixture(
  runId: string,
  analysisReadiness: AnalysisQualityStatus,
  blockingNode: "independent_review" | "field_adjudication" | null,
): AnalysisQualityGraph {
  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    grantId: `grant-${runId}`,
    runId,
    title: runId,
    evaluatedAt: "2026-08-09T00:00:00.000Z",
    analysisReadiness,
    productReadiness: "not_evaluated",
    lanes: {
      deep_analysis: blockingNode === "independent_review" ? "held" : "passed",
      application: blockingNode === "field_adjudication" ? "held" : "passed",
      product: "not_evaluated",
    },
    nodes: blockingNode ? [{
      id: blockingNode,
      lane: blockingNode === "independent_review" ? "deep_analysis" : "application",
      label: blockingNode === "independent_review" ? "독립 AI 검수" : "빠른 작성 필드 판정",
      status: "held",
      hardGate: true,
      summary: "보류",
      evidence: [],
      nextAction: "재판정",
    }] : [],
    edges: [],
    metrics: {
      criteria: 1,
      groundedCriteria: 1,
      assessedAxes: 22,
      ambiguousAxes: 0,
      inputMissingAxes: 0,
      applicationDocuments: 1,
      fieldCandidates: 1,
      acceptedFields: 1,
      unresolvedFields: 0,
      requiredUnresolvedFields: 0,
    },
  };
}

{
  const report = buildAnalysisQualityReport([
    graphFixture("run-a", "passed", null),
    graphFixture("run-b", "held", "independent_review"),
    graphFixture("run-c", "held", "independent_review"),
    graphFixture("run-d", "held", "field_adjudication"),
  ], 30, new Date("2026-08-09T01:00:00.000Z"));

  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.analysis.passed, 1);
  assert.equal(report.summary.analysis.held, 3);
  assert.deepEqual(report.summary.blockers, [
    { nodeId: "independent_review", label: "독립 AI 검수", count: 2 },
    { nodeId: "field_adjudication", label: "빠른 작성 필드 판정", count: 1 },
  ]);
  assert.equal(report.generatedAt, "2026-08-09T01:00:00.000Z");
  console.log("✅ 30건 기준선 집계 — 상태 분포와 차단 단계 빈도");
}
