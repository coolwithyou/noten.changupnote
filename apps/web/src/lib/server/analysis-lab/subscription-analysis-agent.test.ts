import assert from "node:assert/strict";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import type {
  AnalysisQualityGraph,
  AnalysisQualityNode,
  AnalysisQualityStatus,
} from "@/features/dev/analysis-lab/quality-contract";
import {
  buildInitialAgentCommands,
  buildRepairAgentCommands,
  buildReviewAgentCommands,
  classifySubscriptionAgentGraphs,
} from "./subscription-analysis-agent-core";
import { runSubscriptionAnalysisAgent } from "./subscription-analysis-agent";

function node(
  id: AnalysisQualityNode["id"],
  lane: AnalysisQualityNode["lane"],
  status: AnalysisQualityStatus,
): AnalysisQualityNode {
  return {
    id,
    lane,
    label: id,
    status,
    hardGate: true,
    summary: `${id}:${status}`,
    evidence: [],
    nextAction: null,
  };
}

function graph(input: {
  grantId: string;
  readiness: AnalysisQualityStatus;
  review?: AnalysisQualityStatus;
  application?: AnalysisQualityStatus;
  deep?: AnalysisQualityStatus;
}): AnalysisQualityGraph {
  return {
    policyVersion: "analysis-quality-v1",
    grantId: input.grantId,
    runId: `run-${input.grantId}`,
    title: input.grantId,
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    analysisReadiness: input.readiness,
    productReadiness: "not_evaluated",
    lanes: {
      deep_analysis: input.deep ?? input.readiness,
      application: input.application ?? "passed",
      product: "not_evaluated",
    },
    nodes: [
      node("input_sealed", "deep_analysis", "passed"),
      node("deep_contract", "deep_analysis", input.deep ?? "passed"),
      node("independent_review", "deep_analysis", input.review ?? "passed"),
      node("application_source", "application", input.application ?? "passed"),
      node("field_adjudication", "application", input.application ?? "passed"),
    ],
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

// 그래프는 안전 종결, 신청자격 blocker, Kordoc, 22축 계약을 서로 다른 행동으로 접는다.
{
  const decision = classifySubscriptionAgentGraphs([
    graph({ grantId: "done", readiness: "partial" }),
    graph({ grantId: "eligibility", readiness: "held", review: "held" }),
    graph({ grantId: "kordoc", readiness: "held", application: "held" }),
    graph({ grantId: "deep", readiness: "failed", deep: "failed" }),
    graph({ grantId: "unknown", readiness: "held", review: "held" }),
  ], new Set(["eligibility"]));
  assert.deepEqual(decision.completed, ["done"]);
  assert.deepEqual(decision.eligibilityRepair, ["eligibility"]);
  assert.deepEqual(decision.applicationRetry, ["kordoc"]);
  assert.deepEqual(decision.deepRetry, ["deep"]);
  assert.equal(decision.blocked[0]?.grantId, "unknown");
  console.log("✅ 구독 분석 에이전트 그래프 — 종결·신청자격·Kordoc·22축 원인별 분기");
}

// 모든 하위 명령은 정확한 ID와 모델, Kordoc 병렬 실행을 전달한다.
{
  const batch = buildInitialAgentCommands({ grantIds: ["g1", "g2"], maxCostUsd: 65, concurrency: 2 });
  assert.match(batch[0]!.args.join(" "), /--with-application-roundtrip/);
  assert.match(batch[0]!.args.join(" "), /--grant-ids=g1,g2/);
  const review = buildReviewAgentCommands({ grantIds: ["g1"], runIds: ["r1"], maxCostUsd: 65 });
  assert.ok(review[0]!.args.includes("--allow-empty"));
  assert.deepEqual(review.map((command) => command.script), [
    "lab:ai-review",
    "lab:ai-audit",
    "lab:ai-adjudicate",
  ]);
  const repair = buildRepairAgentCommands({
    completed: [],
    eligibilityRepair: ["g1"],
    applicationRetry: ["g2"],
    deepRetry: ["g3"],
    blocked: [],
  });
  assert.deepEqual(repair.map((command) => command.script), [
    "lab:repair-held",
    "lab:repair-quality",
    "lab:repair-quality",
  ]);
  console.log("✅ 구독 분석 에이전트 명령 — 정확 대상·모델 역할·Kordoc 병렬 계약");
}

// 외부 인터페이스 한 번으로 분석→검수→감사→충돌 판정→그래프 종결까지 수행한다.
{
  const commands: string[] = [];
  let graphCalls = 0;
  const run = {
    grantId: "g1",
    runId: "r1",
    error: null,
  } as unknown as LabRun;
  const result = await runSubscriptionAnalysisAgent(
    { count: 1, maxCycles: 2, maxCostUsd: 65, concurrency: 2 },
    {
      inspectWork: async () => ({ analysisIds: ["g1"], recoveryIds: [], newCandidateCount: 0 }),
      selectTargets: async () => {
        throw new Error("신규 선정은 호출되면 안 됨");
      },
      runCommand: async (command) => {
        commands.push(command.script);
      },
      readCurrentRuns: async () => [run],
      loadGraphs: async () => {
        graphCalls += 1;
        return [graphCalls === 1
          ? graph({ grantId: "g1", readiness: "held", review: "held" })
          : graph({ grantId: "g1", readiness: "passed" })];
      },
      loadEligibilityRepairable: async () => new Set(),
      writeReport: async () => "/tmp/subscription-agent-test.json",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    },
  );
  assert.equal(result.report.status, "completed");
  assert.deepEqual(commands, [
    "lab:batch",
    "lab:ai-review",
    "lab:ai-audit",
    "lab:ai-adjudicate",
  ]);
  assert.equal(result.report.cycles.length, 1);
  console.log("✅ 구독 분석 에이전트 인터페이스 — 단일 호출 전체 품질 루프 종결");
}

// 처리할 기존 작업이 없으면 새 모집 공고를 고른 뒤 같은 실행에서 분석한다.
{
  const commands: string[] = [];
  let inspectCalls = 0;
  let selectedCount = 0;
  const currentRuns = ["new-1", "new-2"].map((grantId) => ({
    grantId,
    runId: `run-${grantId}`,
    error: null,
  } as unknown as LabRun));
  const result = await runSubscriptionAnalysisAgent(
    { count: 2, maxCycles: 2, maxCostUsd: 65, concurrency: 2 },
    {
      inspectWork: async () => {
        inspectCalls += 1;
        return inspectCalls === 1
          ? { analysisIds: [], recoveryIds: [], newCandidateCount: 2 }
          : { analysisIds: ["new-1", "new-2"], recoveryIds: [], newCandidateCount: 0 };
      },
      selectTargets: async (count) => {
        selectedCount = count;
        return ["new-1", "new-2"];
      },
      runCommand: async (command) => {
        commands.push(command.script);
      },
      readCurrentRuns: async () => currentRuns,
      loadGraphs: async () => [
        graph({ grantId: "new-1", readiness: "passed" }),
        graph({ grantId: "new-2", readiness: "partial" }),
      ],
      loadEligibilityRepairable: async () => new Set(),
      writeReport: async () => "/tmp/subscription-agent-new-target-test.json",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    },
  );
  assert.equal(selectedCount, 2);
  assert.deepEqual(result.report.selectedNewTargets, ["new-1", "new-2"]);
  assert.deepEqual(commands, ["lab:batch"]);
  assert.equal(result.report.status, "completed");
  console.log("✅ 구독 분석 에이전트 반복성 — 새 모집 공고 자동 선정 후 같은 실행에서 분석");
}

// 기존 Kordoc 보류는 신규 공고보다 먼저 원인별 재분석하고 다음 그래프에서 종결한다.
{
  const commands: string[] = [];
  let graphCalls = 0;
  let selectionCalled = false;
  const run = {
    grantId: "held-kordoc",
    runId: "run-held-kordoc",
    error: null,
  } as unknown as LabRun;
  const result = await runSubscriptionAnalysisAgent(
    { count: 1, maxCycles: 3, maxCostUsd: 65, concurrency: 2 },
    {
      inspectWork: async () => ({
        analysisIds: [],
        recoveryIds: ["held-kordoc"],
        newCandidateCount: 30,
      }),
      selectTargets: async () => {
        selectionCalled = true;
        return [];
      },
      runCommand: async (command) => {
        commands.push(command.script);
      },
      readCurrentRuns: async () => [run],
      loadGraphs: async () => {
        graphCalls += 1;
        return [graphCalls === 1
          ? graph({ grantId: "held-kordoc", readiness: "held", application: "held" })
          : graph({ grantId: "held-kordoc", readiness: "passed" })];
      },
      loadEligibilityRepairable: async () => new Set(),
      writeReport: async () => "/tmp/subscription-agent-recovery-test.json",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    },
  );
  assert.equal(selectionCalled, false);
  assert.deepEqual(commands, ["lab:repair-quality"]);
  assert.deepEqual(result.report.resumedQualityTargets, ["held-kordoc"]);
  assert.equal(result.report.cycles.length, 2);
  assert.equal(result.report.status, "completed");
  console.log("✅ 구독 분석 에이전트 복구 우선순위 — Kordoc 보류 교정 후 품질 그래프 재평가");
}
