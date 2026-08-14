import type {
  AnalysisQualityGraph,
  AnalysisQualityStatus,
} from "@/features/dev/analysis-lab/quality-contract";
import type { LabRunOutcome } from "./run-outcome";

export const SUBSCRIPTION_ANALYSIS_AGENT_VERSION = "subscription-analysis-agent-v1";
export const SUBSCRIPTION_ANALYSIS_AGENT_MODELS = {
  selection: "claude-opus-5",
  analysis: "claude-opus-5",
  roundtrip: "claude-opus-5",
  review: "claude-fable-5",
  audit: "claude-sonnet-5",
  adjudication: "claude-opus-5",
} as const;

export type SubscriptionAgentCommandScript =
  | "lab:select-targets"
  | "lab:batch"
  | "lab:ai-review"
  | "lab:ai-audit"
  | "lab:ai-adjudicate"
  | "lab:repair-held"
  | "lab:repair-quality";

export interface SubscriptionAgentCommand {
  label: string;
  script: SubscriptionAgentCommandScript;
  args: string[];
}

export interface SubscriptionAgentGraphDecision {
  completed: string[];
  eligibilityRepair: string[];
  applicationRetry: string[];
  deepRetry: string[];
  blocked: Array<{ grantId: string; reasons: string[] }>;
}

export interface SubscriptionAgentCycleRecord {
  cycle: number;
  grantIds: string[];
  runIds: string[];
  decision: SubscriptionAgentGraphDecision;
}

export interface SubscriptionAnalysisAgentReport {
  version: typeof SUBSCRIPTION_ANALYSIS_AGENT_VERSION;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "partial" | "failed";
  transport: "claude-cli";
  models: typeof SUBSCRIPTION_ANALYSIS_AGENT_MODELS;
  selectedNewTargets: string[];
  analyzedTargets: string[];
  resumedQualityTargets: string[];
  cycles: SubscriptionAgentCycleRecord[];
  commandLabels: string[];
  error: string | null;
}

export function isTerminalAnalysisStatus(status: AnalysisQualityStatus): boolean {
  return status === "passed" || status === "partial" || status === "not_applicable";
}

/**
 * 품질 그래프를 다음 실행 행동으로 접는다.
 *
 * 호출자는 독립 감사가 확정한 신청자격 blocker 공고를 eligibilityRepairable로 넘긴다.
 * 그래프의 서술 문구를 파싱하지 않고 node id/status만 사용해 정책 변경에 덜 취약하게 둔다.
 */
export function classifySubscriptionAgentGraphs(
  graphs: readonly AnalysisQualityGraph[],
  eligibilityRepairable: ReadonlySet<string>,
  runOutcomes: ReadonlyMap<string, LabRunOutcome>,
): SubscriptionAgentGraphDecision {
  const decision: SubscriptionAgentGraphDecision = {
    completed: [],
    eligibilityRepair: [],
    applicationRetry: [],
    deepRetry: [],
    blocked: [],
  };
  for (const graph of graphs) {
    const runOutcome = runOutcomes.get(graph.grantId);
    if (runOutcome === "held") {
      decision.blocked.push({
        grantId: graph.grantId,
        reasons: ["primary validator 품질 보류 — 명시적 새 experiment 없이 자동 재실행 금지"],
      });
      continue;
    }
    if (runOutcome === "failed") {
      decision.blocked.push({
        grantId: graph.grantId,
        reasons: ["LabRun outcome/error 계약 불일치"],
      });
      continue;
    }
    if (runOutcome !== "publishable") {
      decision.blocked.push({
        grantId: graph.grantId,
        reasons: ["LabRun outcome evidence 없음 — 자동 품질 분기 금지"],
      });
      continue;
    }
    if (isTerminalAnalysisStatus(graph.analysisReadiness)) {
      decision.completed.push(graph.grantId);
      continue;
    }
    if (eligibilityRepairable.has(graph.grantId)) {
      decision.eligibilityRepair.push(graph.grantId);
      continue;
    }
    const applicationFailures = graph.nodes.filter((node) =>
      (node.id === "application_source" || node.id === "field_adjudication")
      && (node.status === "held" || node.status === "failed"));
    if (applicationFailures.length > 0) {
      decision.applicationRetry.push(graph.grantId);
      continue;
    }
    const deepFailures = graph.nodes.filter((node) =>
      (node.id === "input_sealed" || node.id === "deep_contract")
      && (node.status === "held" || node.status === "failed"));
    if (deepFailures.length > 0) {
      decision.deepRetry.push(graph.grantId);
      continue;
    }
    decision.blocked.push({
      grantId: graph.grantId,
      reasons: graph.nodes
        .filter((node) => node.hardGate && (node.status === "held" || node.status === "failed"))
        .map((node) => `${node.label}: ${node.summary}`),
    });
  }
  return decision;
}

export function buildInitialAgentCommands(input: {
  grantIds: readonly string[];
  concurrency: number;
}): SubscriptionAgentCommand[] {
  if (input.grantIds.length === 0) return [];
  const grantIds = input.grantIds.join(",");
  return [{
    label: "딥분석·Kordoc 병렬 실행",
    script: "lab:batch",
    args: [
      "--retry-errors",
      "--reanalyze-outdated",
      "--with-application-roundtrip",
      `--roundtrip-model=${SUBSCRIPTION_ANALYSIS_AGENT_MODELS.roundtrip}`,
      `--limit=${input.grantIds.length}`,
      `--concurrency=${input.concurrency}`,
      `--grant-ids=${grantIds}`,
    ],
  }];
}

export function buildReviewAgentCommands(input: {
  grantIds: readonly string[];
  runIds: readonly string[];
}): SubscriptionAgentCommand[] {
  if (input.grantIds.length === 0) return [];
  const grantIds = input.grantIds.join(",");
  const commands: SubscriptionAgentCommand[] = [{
    label: "Fable 독립 검수",
    script: "lab:ai-review",
    args: [
      `--model=${SUBSCRIPTION_ANALYSIS_AGENT_MODELS.review}`,
      "--allow-empty",
      `--limit=${input.grantIds.length}`,
      `--grant-ids=${grantIds}`,
    ],
  }, {
    label: "Sonnet 블라인드 감사",
    script: "lab:ai-audit",
    args: [
      `--model=${SUBSCRIPTION_ANALYSIS_AGENT_MODELS.audit}`,
      "--create-missing",
      `--limit=${input.grantIds.length}`,
      `--grant-ids=${grantIds}`,
    ],
  }];
  if (input.runIds.length > 0) {
    commands.push({
      label: "Opus 충돌 3차 판정",
      script: "lab:ai-adjudicate",
      args: [
        `--model=${SUBSCRIPTION_ANALYSIS_AGENT_MODELS.adjudication}`,
        `--run-ids=${input.runIds.join(",")}`,
      ],
    });
  }
  return commands;
}

export function buildRepairAgentCommands(
  decision: SubscriptionAgentGraphDecision,
): SubscriptionAgentCommand[] {
  const commands: SubscriptionAgentCommand[] = [];
  if (decision.eligibilityRepair.length > 0) {
    commands.push({
      label: "신청자격 blocker 누적 교정",
      script: "lab:repair-held",
      args: [`--grant-ids=${decision.eligibilityRepair.join(",")}`],
    });
  }
  if (decision.applicationRetry.length > 0) {
    commands.push({
      label: "Kordoc 품질 재분석",
      script: "lab:repair-quality",
      args: [
        "--reason=application",
        `--grant-ids=${decision.applicationRetry.join(",")}`,
      ],
    });
  }
  if (decision.deepRetry.length > 0) {
    commands.push({
      label: "22축 계약 재분석",
      script: "lab:repair-quality",
      args: [
        "--reason=deep_contract",
        `--grant-ids=${decision.deepRetry.join(",")}`,
      ],
    });
  }
  return commands;
}

export function repairTargetIds(decision: SubscriptionAgentGraphDecision): string[] {
  return [...new Set([
    ...decision.eligibilityRepair,
    ...decision.applicationRetry,
    ...decision.deepRetry,
  ])];
}
