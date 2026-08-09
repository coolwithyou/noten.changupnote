import assert from "node:assert/strict";
import { ANALYSIS_QUALITY_POLICY_VERSION, type AnalysisQualityGraph } from "@/features/dev/analysis-lab/quality-contract";
import type { LabBatchEvent, LabBatchJobSnapshot, LabRun } from "@/features/dev/analysis-lab/contract";
import { evaluateAnalysisBulkReadiness } from "./bulk-readiness";

function snapshot(state: LabBatchJobSnapshot["state"] = "finished"): LabBatchJobSnapshot {
  const events: LabBatchEvent[] = [];
  for (let index = 0; index < 5; index += 1) {
    events.push({ type: "target-started", index, total: 5, grantId: `grant-${index}`, stratum: "pilot" });
    events.push({
      type: "target-ok",
      index,
      total: 5,
      grantId: `grant-${index}`,
      stratum: "pilot",
      title: `공고 ${index}`,
      durationMs: 1,
      costUsd: 0,
      cumulativeCostUsd: 0,
    });
  }
  return {
    jobId: "job-2026-08-09T000000.000Z-aaaaaa",
    state,
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: state === "running" ? null : "2026-08-09T00:01:00.000Z",
    options: {
      limit: 5,
      concurrency: 2,
      maxCostUsd: 15,
      retryErrors: false,
      reanalyzeOutdated: true,
      withApplicationRoundtrip: true,
      transport: "claude-cli",
      model: "claude-opus-5",
    },
    progress: { total: 5, started: 5, ok: 5, error: 0, cumulativeCostUsd: 0 },
    guardStop: null,
    summary: state === "running" ? null : {
      ok: 5,
      errorRuns: 0,
      unsavedFailures: 0,
      notStarted: 0,
      skippedOk: 0,
      skippedOkOutdatedOnly: 0,
      heldError: 0,
      periodSkipped: 0,
      totalCostUsd: 0,
      durationMs: 60_000,
      stopReason: "completed",
    },
    events,
    error: null,
  };
}

function run(index: number): LabRun {
  return {
    runId: `run-2026-08-09T00000${index}.000Z-aaaaaa`,
    grantId: `grant-${index}`,
    source: "kstartup",
    sourceId: String(index),
    title: `공고 ${index}`,
    model: "claude-opus-5",
    transport: "claude-cli",
    promptVersion: "lab-deep-v11",
    startedAt: "2026-08-09T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [{ label: "본문", chars: 1, truncated: false }],
    inputTotalChars: 1,
    inputSha256: "a".repeat(64),
    usage: null,
    costUsd: 0,
    analysisMarkdown: "ok",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    applicationRoundtrip: {
      status: "complete",
      runId: `roundtrip-${index}`,
      transport: "claude-cli",
      model: "claude-opus-5",
      documentCount: 1,
      sourceCount: 1,
      errorCode: null,
      error: null,
    },
    error: null,
  };
}

function graph(index: number, overrides: Partial<AnalysisQualityGraph> = {}): AnalysisQualityGraph {
  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    grantId: `grant-${index}`,
    runId: `run-${index}`,
    title: `공고 ${index}`,
    evaluatedAt: "2026-08-09T00:00:00.000Z",
    analysisReadiness: "passed",
    productReadiness: "not_evaluated",
    lanes: { deep_analysis: "passed", application: "passed", product: "not_evaluated" },
    nodes: [],
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
    ...overrides,
  };
}

const runs = new Map(Array.from({ length: 5 }, (_, index) => [`grant-${index}`, run(index)]));
const graphs = new Map(Array.from({ length: 5 }, (_, index) => [`grant-${index}`, graph(index)]));
const passed = evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot(), runs, graphs });
assert.equal(passed.verdict, "GO");
assert.ok(passed.gates.every((gate) => gate.status === "passed"));

const partialGraphs = new Map(graphs);
partialGraphs.set("grant-2", graph(2, {
  lanes: { deep_analysis: "passed", application: "partial", product: "not_evaluated" },
  analysisReadiness: "partial",
  metrics: { ...graph(2).metrics, unresolvedFields: 2, requiredUnresolvedFields: 0 },
}));
assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot(), runs, graphs: partialGraphs }).verdict,
  "GO",
  "비필수 미해결만 남은 Kordoc partial은 안전 종결",
);

const requiredGraphs = new Map(graphs);
requiredGraphs.set("grant-2", graph(2, {
  lanes: { deep_analysis: "passed", application: "partial", product: "not_evaluated" },
  analysisReadiness: "partial",
  metrics: { ...graph(2).metrics, unresolvedFields: 1, requiredUnresolvedFields: 1 },
}));
const iterate = evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot(), runs, graphs: requiredGraphs });
assert.equal(iterate.verdict, "ITERATE");
assert.equal(iterate.gates.find((gate) => gate.id === "application_quality")?.status, "failed");
assert.ok(iterate.nextActions.some((action) => action.endsWith("grant-2")));

const apiRuns = new Map(runs);
apiRuns.set("grant-1", { ...run(1), transport: "api" });
assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot(), runs: apiRuns, graphs }).verdict,
  "BLOCKED",
);

const apiRoundtripRuns = new Map(runs);
apiRoundtripRuns.set("grant-1", {
  ...run(1),
  applicationRoundtrip: { ...run(1).applicationRoundtrip!, transport: "api" },
});
assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot(), runs: apiRoundtripRuns, graphs }).verdict,
  "BLOCKED",
  "딥분석은 구독이어도 Kordoc이 API이면 차단",
);

const apiBatch = snapshot();
apiBatch.options = apiBatch.options ? { ...apiBatch.options, transport: "api" } : null;
assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: apiBatch, runs, graphs }).verdict,
  "BLOCKED",
  "개별 런이 구독 provenance여도 배치 요청이 API이면 차단",
);

const noRoundtripBatch = snapshot();
noRoundtripBatch.options = noRoundtripBatch.options
  ? { ...noRoundtripBatch.options, withApplicationRoundtrip: false }
  : null;
assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: noRoundtripBatch, runs, graphs }).verdict,
  "BLOCKED",
  "Kordoc 병렬 실행을 끈 배치는 대량 준비로 인정하지 않음",
);

assert.equal(
  evaluateAnalysisBulkReadiness({ stage: "pilot5", snapshot: snapshot("running"), runs, graphs }).verdict,
  "WAIT",
);

console.log("analysis bulk readiness tests: ok");
