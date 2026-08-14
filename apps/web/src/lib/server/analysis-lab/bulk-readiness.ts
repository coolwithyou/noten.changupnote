import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisQualityGraph } from "@/features/dev/analysis-lab/quality-contract";
import type { LabBatchJobSnapshot, LabRun } from "@/features/dev/analysis-lab/contract";
import { analysisLabDir } from "./run-store";
import { isPublishableLabRun } from "./run-outcome";

export const ANALYSIS_BULK_READINESS_SCHEMA = "analysis-bulk-readiness-v1" as const;
export const ANALYSIS_BULK_READINESS_MODEL = "claude-opus-5" as const;

export type AnalysisBulkReadinessStage = "pilot5" | "batch30";
export type AnalysisBulkReadinessVerdict = "GO" | "ITERATE" | "WAIT" | "BLOCKED";

export interface AnalysisBulkReadinessGate {
  id: "batch_terminal" | "sample_complete" | "subscription_provenance" | "deep_quality" | "application_quality";
  label: string;
  status: "passed" | "failed" | "waiting";
  summary: string;
  evidence: string[];
}

export interface AnalysisBulkReadinessItem {
  grantId: string;
  runId: string | null;
  title: string | null;
  deepStatus: string | null;
  applicationStatus: string | null;
  applicationTransport: string | null;
  applicationModel: string | null;
  requiredUnresolvedFields: number | null;
  issues: string[];
}

export interface AnalysisBulkReadinessArtifact {
  schema: typeof ANALYSIS_BULK_READINESS_SCHEMA;
  readinessId: string;
  stage: AnalysisBulkReadinessStage;
  expectedCount: 5 | 30;
  batchJobId: string;
  evaluatedAt: string;
  verdict: AnalysisBulkReadinessVerdict;
  gates: AnalysisBulkReadinessGate[];
  targetGrantIds: string[];
  items: AnalysisBulkReadinessItem[];
  nextActions: string[];
}

export function evaluateAnalysisBulkReadiness(input: {
  stage: AnalysisBulkReadinessStage;
  snapshot: LabBatchJobSnapshot;
  runs: ReadonlyMap<string, LabRun>;
  graphs: ReadonlyMap<string, AnalysisQualityGraph>;
  now?: Date;
}): AnalysisBulkReadinessArtifact {
  const expectedCount = input.stage === "pilot5" ? 5 : 30;
  const started = targetIds(input.snapshot, "target-started");
  const ok = new Set(targetIds(input.snapshot, "target-ok"));
  const held = new Set(targetIds(input.snapshot, "target-held"));
  const terminal = new Set([...ok, ...held]);
  const errors = input.snapshot.events.filter((event) => event.type === "target-error");
  const summary = input.snapshot.summary;
  const batchSubscriptionConfigured = input.snapshot.options?.transport === "claude-cli"
    && input.snapshot.options.model === ANALYSIS_BULK_READINESS_MODEL
    && input.snapshot.options.withApplicationRoundtrip === true;
  const batchWaiting = input.snapshot.state === "running";
  const legacySubscriptionCostStopAfterCompletion =
    input.snapshot.options?.transport === "claude-cli"
    && summary !== null
    && summary.stopReason === "cost-cap"
    && (summary.notStarted ?? 0) === 0
    && started.length > 0
    && terminal.size === started.length
    && started.every((grantId) => terminal.has(grantId));
  const batchPassed = input.snapshot.state === "finished"
    && (
      summary?.stopReason === "completed"
      || legacySubscriptionCostStopAfterCompletion
    )
    && (summary?.errorRuns ?? 0) === 0
    && (summary?.unsavedFailures ?? 0) === 0
    && (summary?.notStarted ?? 0) === 0
    && errors.length === 0;
  const samplePassed = started.length === expectedCount
    && terminal.size === expectedCount
    && started.every((grantId) => terminal.has(grantId));

  const items = started.map((grantId): AnalysisBulkReadinessItem => {
    const run = input.runs.get(grantId) ?? null;
    const graph = input.graphs.get(grantId) ?? null;
    const issues: string[] = [];
    if (!run) issues.push("현행 LabRun 없음");
    if (held.has(grantId)) issues.push("배치 primary 품질 보류");
    if (run && !isPublishableLabRun(run)) issues.push("primary 품질 보류");
    if (run && (run.transport !== "claude-cli" || run.model !== ANALYSIS_BULK_READINESS_MODEL)) {
      issues.push(`구독 provenance 불일치: ${run.transport ?? "api"}/${run.model}`);
    }
    if (run && (
      run.applicationRoundtrip?.transport !== "claude-cli"
      || run.applicationRoundtrip.model !== ANALYSIS_BULK_READINESS_MODEL
    )) {
      issues.push(
        `Kordoc 구독 provenance 불일치: ${run.applicationRoundtrip?.transport ?? "미실행"}/${run.applicationRoundtrip?.model ?? "미실행"}`,
      );
    }
    if (!graph) issues.push("품질 그래프 없음");
    if (graph && !deepSafe(graph)) {
      issues.push(`딥분석 ${graph.lanes.deep_analysis}`);
    }
    if (graph && !applicationSafe(graph)) {
      issues.push(`Kordoc ${graph.lanes.application} · 필수 미해결 ${graph.metrics.requiredUnresolvedFields}`);
    }
    return {
      grantId,
      runId: run?.runId ?? null,
      title: run?.title ?? null,
      deepStatus: graph?.lanes.deep_analysis ?? null,
      applicationStatus: graph?.lanes.application ?? null,
      applicationTransport: run?.applicationRoundtrip?.transport ?? null,
      applicationModel: run?.applicationRoundtrip?.model ?? null,
      requiredUnresolvedFields: graph?.metrics.requiredUnresolvedFields ?? null,
      issues,
    };
  });

  const provenancePassed = batchSubscriptionConfigured
    && items.length === expectedCount
    && items.every((item) => !item.issues.some((issue) => issue.includes("provenance") || issue.includes("LabRun 없음")));
  const deepPassed = items.length === expectedCount
    && items.every((item) => {
      const run = input.runs.get(item.grantId);
      const graph = input.graphs.get(item.grantId);
      return !held.has(item.grantId) && run && isPublishableLabRun(run) && graph
        ? deepSafe(graph)
        : false;
    });
  const applicationPassed = items.length === expectedCount
    && items.every((item) => {
      const graph = input.graphs.get(item.grantId);
      return graph ? applicationSafe(graph) : false;
    });

  const gates: AnalysisBulkReadinessGate[] = [
    gate(
      "batch_terminal",
      "배치 정상 종결",
      batchWaiting ? "waiting" : batchPassed ? "passed" : "failed",
      batchWaiting
        ? `배치가 실행 중입니다: ${input.snapshot.progress?.ok ?? 0}/${expectedCount}`
        : batchPassed
          ? legacySubscriptionCostStopAfterCompletion
            ? "구독 legacy 명목 비용 중단 기록이지만 전건 terminal로 종결했습니다."
            : "윈도·오류 중단 없이 정상 종결했습니다."
          : `배치 상태 ${input.snapshot.state}, 중단 ${input.snapshot.summary?.stopReason ?? "미기록"}`,
      [`job ${input.snapshot.jobId ?? "없음"}`, `error events ${errors.length}`],
    ),
    gate(
      "sample_complete",
      "정확한 표본 완주",
      batchWaiting ? "waiting" : samplePassed ? "passed" : "failed",
      `${terminal.size}/${expectedCount}건 terminal (발행 가능 ${ok.size} · 품질 보류 ${held.size}) · 시작 ${started.length}건`,
      [`대상 중복 ${started.length - new Set(started).size}건`],
    ),
    gate(
      "subscription_provenance",
      "구독 모델 provenance",
      batchWaiting && items.length < expectedCount ? "waiting" : provenancePassed ? "passed" : "failed",
      provenancePassed
        ? `${expectedCount}건 모두 claude-cli/${ANALYSIS_BULK_READINESS_MODEL} · Kordoc 병렬 실행`
        : "배치 설정이나 개별 런에 API·다른 모델·Kordoc 미실행·누락이 있습니다.",
      [
        `batch ${input.snapshot.options?.transport ?? "없음"}/${input.snapshot.options?.model ?? "없음"}`,
        `Kordoc 병렬 ${input.snapshot.options?.withApplicationRoundtrip === true ? "사용" : "미사용"}`,
        ...items.flatMap((item) => item.issues.filter((issue) => issue.includes("provenance") || issue.includes("LabRun"))),
      ],
    ),
    gate(
      "deep_quality",
      "딥분석 안전 종결",
      batchWaiting && items.length < expectedCount ? "waiting" : deepPassed ? "passed" : "failed",
      `${items.filter((item) => {
        const run = input.runs.get(item.grantId);
        const graph = input.graphs.get(item.grantId);
        return !held.has(item.grantId) && run && isPublishableLabRun(run) && graph
          ? deepSafe(graph)
          : false;
      }).length}/${expectedCount}건 안전 종결`,
      items.filter((item) => {
        const run = input.runs.get(item.grantId);
        const graph = input.graphs.get(item.grantId);
        return held.has(item.grantId) || !run || !isPublishableLabRun(run) || !graph || !deepSafe(graph);
      }).map((item) => `${item.grantId}: ${item.deepStatus ?? "미검증"}`),
    ),
    gate(
      "application_quality",
      "Kordoc 안전 종결",
      batchWaiting && items.length < expectedCount ? "waiting" : applicationPassed ? "passed" : "failed",
      `${items.filter((item) => {
        const graph = input.graphs.get(item.grantId);
        return graph ? applicationSafe(graph) : false;
      }).length}/${expectedCount}건 안전 종결`,
      items.filter((item) => {
        const graph = input.graphs.get(item.grantId);
        return !graph || !applicationSafe(graph);
      }).map((item) => `${item.grantId}: ${item.applicationStatus ?? "미검증"}, 필수 미해결 ${item.requiredUnresolvedFields ?? "?"}`),
    ),
  ];
  const waiting = gates.some((item) => item.status === "waiting");
  const hardBatchFailure = !waiting && (!batchPassed || !samplePassed || !provenancePassed);
  const verdict: AnalysisBulkReadinessVerdict = waiting
    ? "WAIT"
    : gates.every((item) => item.status === "passed")
      ? "GO"
      : hardBatchFailure
        ? "BLOCKED"
        : "ITERATE";
  const nextActions = buildNextActions({
    batchWaiting,
    batchPassed,
    samplePassed,
    provenancePassed,
    deepFailedGrantIds: items.filter((item) => {
      const run = input.runs.get(item.grantId);
      const graph = input.graphs.get(item.grantId);
      return held.has(item.grantId) || !run || !isPublishableLabRun(run) || !graph || !deepSafe(graph);
    }).map((item) => item.grantId),
    applicationFailedGrantIds: items.filter((item) => {
      const graph = input.graphs.get(item.grantId);
      return !graph || !applicationSafe(graph);
    }).map((item) => item.grantId),
  });
  const evaluatedAt = (input.now ?? new Date()).toISOString();
  return {
    schema: ANALYSIS_BULK_READINESS_SCHEMA,
    readinessId: `bulk-${input.stage}-${evaluatedAt.replace(/:/g, "")}-${randomBytes(3).toString("hex")}`,
    stage: input.stage,
    expectedCount,
    batchJobId: input.snapshot.jobId ?? "missing-job",
    evaluatedAt,
    verdict,
    gates,
    targetGrantIds: started,
    items,
    nextActions,
  };
}

export async function writeAnalysisBulkReadinessArtifact(
  artifact: AnalysisBulkReadinessArtifact,
): Promise<string> {
  if (artifact.verdict === "WAIT") throw new Error("실행 중인 배치의 준비 판정은 저장하지 않습니다.");
  const dir = join(analysisLabDir(), "bulk-readiness", safeSegment(artifact.batchJobId));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${safeSegment(artifact.readinessId)}.json`);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function applicationSafe(graph: AnalysisQualityGraph): boolean {
  return (graph.lanes.application === "passed"
      || graph.lanes.application === "partial"
      || graph.lanes.application === "not_applicable")
    && graph.metrics.requiredUnresolvedFields === 0;
}

function deepSafe(graph: AnalysisQualityGraph): boolean {
  return graph.lanes.deep_analysis === "passed" || graph.lanes.deep_analysis === "partial";
}

function targetIds(
  snapshot: LabBatchJobSnapshot,
  type: "target-started" | "target-ok" | "target-held",
): string[] {
  const indexed = snapshot.events
    .filter((event): event is Extract<(typeof snapshot.events)[number], { type: typeof type }> => event.type === type)
    .sort((left, right) => left.index - right.index);
  return [...new Set(indexed.map((event) => event.grantId))];
}

function gate(
  id: AnalysisBulkReadinessGate["id"],
  label: string,
  status: AnalysisBulkReadinessGate["status"],
  summary: string,
  evidence: string[],
): AnalysisBulkReadinessGate {
  return { id, label, status, summary, evidence };
}

function buildNextActions(input: {
  batchWaiting: boolean;
  batchPassed: boolean;
  samplePassed: boolean;
  provenancePassed: boolean;
  deepFailedGrantIds: string[];
  applicationFailedGrantIds: string[];
}): string[] {
  if (input.batchWaiting) return ["현재 배치가 끝날 때까지 기다린 뒤 같은 판정을 다시 실행하세요."];
  const actions: string[] = [];
  if (!input.batchPassed || !input.samplePassed) actions.push("배치 오류·윈도·미착수 공고만 좁혀 재실행하세요.");
  if (!input.provenancePassed) actions.push("API 폴백 없이 claude-cli/claude-opus-5로 누락 공고를 다시 분석하세요.");
  if (input.deepFailedGrantIds.length > 0) {
    actions.push(
      `딥분석 검수·감사 대상 ${input.deepFailedGrantIds.length}건: ${input.deepFailedGrantIds.join(",")}`,
    );
  }
  if (input.applicationFailedGrantIds.length > 0) {
    actions.push(
      `Kordoc Opus 재판정 대상 ${input.applicationFailedGrantIds.length}건: ${input.applicationFailedGrantIds.join(",")}`,
    );
  }
  return actions;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
