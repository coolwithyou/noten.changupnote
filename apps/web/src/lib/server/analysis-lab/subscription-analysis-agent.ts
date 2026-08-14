// 반복형 로컬 구독 분석 에이전트.
//
// 단일 인터페이스 뒤에서 신규 대상 탐색 → 딥분석/Kordoc 병렬 실행 → Fable 검수 →
// Sonnet 감사 → Opus 충돌 판정 → 품질 그래프 원인별 제한 재분석을 수행한다.
// 운영 API·승격·DB 분석 결과 쓰기는 하지 않으며, 각 단계는 기존 fail-closed CLI를 재사용한다.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ANALYSIS_LAB_MAX_BATCH_CONCURRENCY,
  AI_REVIEW_ADOPTED,
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import type { AnalysisQualityGraph } from "@/features/dev/analysis-lab/quality-contract";
import { partitionCohortEntries } from "./batch-plan";
import {
  scanExistingRuns,
  splitByPeriodPolicy,
} from "./batch-runner";
import { readCohortFileV2 } from "./cohort-file";
import { buildHeldReviewRepairPlan } from "./held-review-repair";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { loadAnalysisQualityGraphForRun } from "./quality-report";
import {
  analysisLabDir,
  readLatestTerminalLabRunIndexForPrompt,
} from "./run-store";
import { classifyLabRunOutcome, isPublishableLabRun } from "./run-outcome";
import {
  loadAutomaticTargetCandidates,
} from "./target-selection";
import {
  SUBSCRIPTION_ANALYSIS_AGENT_MODELS,
  SUBSCRIPTION_ANALYSIS_AGENT_VERSION,
  buildInitialAgentCommands,
  buildRepairAgentCommands,
  buildReviewAgentCommands,
  classifySubscriptionAgentGraphs,
  isTerminalAnalysisStatus,
  repairTargetIds,
  type SubscriptionAgentCommand,
  type SubscriptionAnalysisAgentReport,
} from "./subscription-analysis-agent-core";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { assertAnalysisLabLiveExecutionAdmitted } from "./analysis-execution-admission";

loadAnalysisLabEnv();

export interface SubscriptionAnalysisAgentOptions {
  count: number;
  maxCycles: number;
  concurrency: number;
}

export interface SubscriptionAgentWork {
  analysisIds: string[];
  recoveryIds: string[];
  newCandidateCount: number;
}

export interface SubscriptionAnalysisAgentResult {
  report: SubscriptionAnalysisAgentReport;
  artifactPath: string;
}

export interface SubscriptionAnalysisAgentDeps {
  inspectWork: (limit: number) => Promise<SubscriptionAgentWork>;
  selectTargets: (count: number) => Promise<string[]>;
  runCommand: (command: SubscriptionAgentCommand) => Promise<void>;
  readCurrentRuns: (grantIds: readonly string[]) => Promise<LabRun[]>;
  loadGraphs: (runs: readonly LabRun[]) => Promise<AnalysisQualityGraph[]>;
  loadEligibilityRepairable: (
    grantIds: readonly string[],
    currentRuns: readonly LabRun[],
  ) => Promise<Set<string>>;
  writeReport: (report: SubscriptionAnalysisAgentReport) => Promise<string>;
  now: () => Date;
}

export async function runSubscriptionAnalysisAgent(
  options: SubscriptionAnalysisAgentOptions,
  dependencyOverrides: Partial<SubscriptionAnalysisAgentDeps> = {},
): Promise<SubscriptionAnalysisAgentResult> {
  assertOptions(options);
  const deps = agentDependencies(dependencyOverrides);
  const startedAt = deps.now();
  const agentId = `agent-${startedAt.toISOString().replace(/[:.]/g, "")}-${randomBytes(3).toString("hex")}`;
  const report: SubscriptionAnalysisAgentReport = {
    version: SUBSCRIPTION_ANALYSIS_AGENT_VERSION,
    agentId,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    status: "partial",
    transport: "claude-cli",
    models: SUBSCRIPTION_ANALYSIS_AGENT_MODELS,
    selectedNewTargets: [],
    analyzedTargets: [],
    resumedQualityTargets: [],
    cycles: [],
    commandLabels: [],
    error: null,
  };

  try {
    let work = await deps.inspectWork(options.count);
    if (work.analysisIds.length === 0 && work.recoveryIds.length === 0) {
      if (work.newCandidateCount === 0) {
        report.status = "completed";
        report.finishedAt = deps.now().toISOString();
        return { report, artifactPath: await deps.writeReport(report) };
      }
      const selectionCount = Math.min(options.count, work.newCandidateCount);
      report.commandLabels.push("신규 모집 공고 자동 선정");
      report.selectedNewTargets = await deps.selectTargets(selectionCount);
      work = await deps.inspectWork(options.count);
    }

    const recoveryIds = work.recoveryIds.slice(0, options.count);
    const analysisCapacity = Math.max(0, options.count - recoveryIds.length);
    const analysisIds = work.analysisIds.slice(0, analysisCapacity);
    report.resumedQualityTargets = recoveryIds;
    report.analyzedTargets = analysisIds;

    if (analysisIds.length > 0) {
      await runCommands(
        buildInitialAgentCommands({
          grantIds: analysisIds,
          concurrency: options.concurrency,
        }),
        deps,
        report,
      );
    }

    let activeIds = [...new Set([...recoveryIds, ...analysisIds])];
    for (let cycle = 1; cycle <= options.maxCycles && activeIds.length > 0; cycle += 1) {
      let currentRuns = await deps.readCurrentRuns(activeIds);
      const runIdsByGrant = new Map(currentRuns.map((run) => [run.grantId, run.runId]));
      const missingRuns = activeIds.filter((grantId) => !runIdsByGrant.has(grantId));
      if (missingRuns.length > 0) {
        throw new Error(`현행 terminal 런을 만들지 못한 공고: ${missingRuns.join(", ")}`);
      }

      let graphs = await deps.loadGraphs(currentRuns);
      let runOutcomes = new Map(currentRuns.map((run) => [run.grantId, classifyLabRunOutcome(run)]));
      const reviewIds = graphs.filter((graph) => {
        if (runOutcomes.get(graph.grantId) !== "publishable") return false;
        const review = graph.nodes.find((node) => node.id === "independent_review");
        return review?.status === "held" || review?.status === "failed";
      }).map((graph) => graph.grantId);
      if (reviewIds.length > 0) {
        const reviewRunIds = reviewIds.map((grantId) => runIdsByGrant.get(grantId)!).filter(Boolean);
        await runCommands(
          buildReviewAgentCommands({
            grantIds: reviewIds,
            runIds: reviewRunIds,
          }),
          deps,
          report,
        );
        currentRuns = await deps.readCurrentRuns(activeIds);
        graphs = await deps.loadGraphs(currentRuns);
        runOutcomes = new Map(currentRuns.map((run) => [run.grantId, classifyLabRunOutcome(run)]));
      }

      const eligibilityRepairable = await deps.loadEligibilityRepairable(activeIds, currentRuns);
      const decision = classifySubscriptionAgentGraphs(graphs, eligibilityRepairable, runOutcomes);
      report.cycles.push({
        cycle,
        grantIds: [...activeIds],
        runIds: currentRuns.map((run) => run.runId),
        decision,
      });
      const repairIds = repairTargetIds(decision);
      if (repairIds.length === 0) {
        report.status = decision.blocked.length === 0 ? "completed" : "partial";
        break;
      }
      if (cycle === options.maxCycles) {
        report.status = "partial";
        break;
      }
      await runCommands(buildRepairAgentCommands(decision), deps, report);
      activeIds = repairIds;
    }
    report.finishedAt = deps.now().toISOString();
    return { report, artifactPath: await deps.writeReport(report) };
  } catch (caught) {
    report.status = "failed";
    report.error = caught instanceof Error ? caught.message : String(caught);
    report.finishedAt = deps.now().toISOString();
    const artifactPath = await deps.writeReport(report);
    return { report, artifactPath };
  }
}

export async function inspectSubscriptionAgentWork(limit: number): Promise<SubscriptionAgentWork> {
  const cohort = await readCohortFileV2();
  const entries = cohort?.entries ?? [];
  const { states } = await scanExistingRuns();
  const period = await splitByPeriodPolicy(entries);
  const partition = partitionCohortEntries(period.runnable, states, {
    retryErrors: true,
    reanalyzeOutdated: true,
  });
  const index = await readLatestTerminalLabRunIndexForPrompt(ANALYSIS_LAB_PROMPT_VERSION);
  const currentRuns = period.runnable.flatMap((entry) => {
    const run = index.get(entry.grantId);
    return run ? [run] : [];
  });
  const graphs = await Promise.all(currentRuns.filter(isPublishableLabRun).map(loadAnalysisQualityGraphForRun));
  const recoveryIds = graphs
    .filter((graph) => !isTerminalAnalysisStatus(graph.analysisReadiness))
    .map((graph) => graph.grantId)
    .slice(0, limit);
  const recoverySet = new Set(recoveryIds);
  const analysisIds = partition.pending
    .map((entry) => entry.grantId)
    .filter((grantId) => !recoverySet.has(grantId))
    .slice(0, limit);

  const existingIds = new Set(entries.map((entry) => entry.grantId));
  const analyzedIds = new Set(states.keys());
  const candidates = await loadAutomaticTargetCandidates(new Date());
  const newCandidateCount = candidates.filter((candidate) =>
    !existingIds.has(candidate.grantId) && !analyzedIds.has(candidate.grantId)).length;
  return { analysisIds, recoveryIds, newCandidateCount };
}

async function loadCurrentRuns(grantIds: readonly string[]): Promise<LabRun[]> {
  const index = await readLatestTerminalLabRunIndexForPrompt(ANALYSIS_LAB_PROMPT_VERSION);
  return grantIds.flatMap((grantId) => {
    const run = index.get(grantId);
    return run ? [run] : [];
  });
}

async function loadEligibilityRepairable(
  grantIds: readonly string[],
  currentRuns: readonly LabRun[],
): Promise<Set<string>> {
  const wanted = new Set(grantIds);
  const currentRunIds = new Map(currentRuns.map((run) => [run.grantId, run.runId]));
  const selection = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll: true,
    keepAllRuns: true,
  });
  return new Set(selection.confirmed.filter((item) =>
    wanted.has(item.run.grantId)
    && currentRunIds.get(item.run.grantId) === item.run.runId
    && buildHeldReviewRepairPlan({ run: item.run, review: item.review }) !== null)
    .map((item) => item.run.grantId));
}

async function selectTargets(count: number): Promise<string[]> {
  const before = await readCohortFileV2();
  const beforeIds = new Set(before?.entries.map((entry) => entry.grantId) ?? []);
  await runAgentCommand({
    label: "신규 모집 공고 자동 선정",
    script: "lab:select-targets",
    args: [
      `--count=${count}`,
      "--up-to",
      `--model=${SUBSCRIPTION_ANALYSIS_AGENT_MODELS.selection}`,
    ],
  });
  const after = await readCohortFileV2();
  return after?.entries.map((entry) => entry.grantId).filter((grantId) => !beforeIds.has(grantId)) ?? [];
}

async function runAgentCommand(command: SubscriptionAgentCommand): Promise<void> {
  console.log(`\n[subscription-agent] ${command.label}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", [command.script, "--", ...command.args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        ANALYSIS_LAB_TIMEOUT_MS: process.env.ANALYSIS_LAB_TIMEOUT_MS?.trim() || "900000",
        ANALYSIS_LAB_TRANSPORT: "claude-cli",
        ANALYSIS_LAB_MODEL: SUBSCRIPTION_ANALYSIS_AGENT_MODELS.analysis,
        ANALYSIS_LAB_ROUNDTRIP_MODEL: SUBSCRIPTION_ANALYSIS_AGENT_MODELS.roundtrip,
        // 구독 경로가 실수로 API credential에 폴백하지 못하게 자식 프로세스에서 제거한다.
        ANTHROPIC_API_KEY: "",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.label} 실패(exit=${code ?? "null"}, signal=${signal ?? "none"})`));
    });
  });
}

async function writeAgentReport(report: SubscriptionAnalysisAgentReport): Promise<string> {
  const path = join(analysisLabDir(), "agent-runs", `${report.agentId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function agentDependencies(
  overrides: Partial<SubscriptionAnalysisAgentDeps>,
): SubscriptionAnalysisAgentDeps {
  return {
    inspectWork: overrides.inspectWork ?? inspectSubscriptionAgentWork,
    selectTargets: overrides.selectTargets ?? selectTargets,
    runCommand: overrides.runCommand ?? runAgentCommand,
    readCurrentRuns: overrides.readCurrentRuns ?? loadCurrentRuns,
    loadGraphs: overrides.loadGraphs ?? (async (runs) => Promise.all(runs.map(loadAnalysisQualityGraphForRun))),
    loadEligibilityRepairable: overrides.loadEligibilityRepairable ?? loadEligibilityRepairable,
    writeReport: overrides.writeReport ?? writeAgentReport,
    now: overrides.now ?? (() => new Date()),
  };
}

async function runCommands(
  commands: readonly SubscriptionAgentCommand[],
  deps: SubscriptionAnalysisAgentDeps,
  report: SubscriptionAnalysisAgentReport,
): Promise<void> {
  for (const command of commands) {
    report.commandLabels.push(command.label);
    await deps.runCommand(command);
  }
}

function assertOptions(options: SubscriptionAnalysisAgentOptions): void {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 30) {
    throw new Error("count는 1~30 정수여야 합니다.");
  }
  if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1 || options.maxCycles > 5) {
    throw new Error("maxCycles는 1~5 정수여야 합니다.");
  }
  if (
    !Number.isInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > ANALYSIS_LAB_MAX_BATCH_CONCURRENCY
  ) {
    throw new Error(`concurrency는 1~${ANALYSIS_LAB_MAX_BATCH_CONCURRENCY} 정수여야 합니다.`);
  }
}

export function parseSubscriptionAnalysisAgentCliOptions(
  args: string[],
  warn: (message: string) => void = console.warn,
): SubscriptionAnalysisAgentOptions & { execute: boolean } {
  let count = 30;
  let maxCycles = 3;
  let concurrency = 2;
  let execute = false;
  let legacyMaxCostSeen = false;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--execute") execute = true;
    else if (arg.startsWith("--count=")) count = Number(arg.slice("--count=".length));
    else if (arg.startsWith("--max-cycles=")) maxCycles = Number(arg.slice("--max-cycles=".length));
    else if (arg.startsWith("--max-cost-usd=")) legacyMaxCostSeen = true;
    else if (arg.startsWith("--concurrency=")) concurrency = Number(arg.slice("--concurrency=".length));
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (legacyMaxCostSeen) {
    warn(
      "[subscription-agent] --max-cost-usd는 구독 실행을 더 이상 중단하지 않으며 무시됩니다. "
      + "명목 USD는 telemetry로만 기록됩니다.",
    );
  }
  const options = { count, maxCycles, concurrency };
  assertOptions(options);
  return { ...options, execute };
}

async function main(): Promise<number> {
  if ((process.env.ANALYSIS_LAB_TRANSPORT ?? "").trim() !== "claude-cli") {
    throw new Error("ANALYSIS_LAB_TRANSPORT=claude-cli가 필요합니다.");
  }
  const options = parseSubscriptionAnalysisAgentCliOptions(process.argv.slice(2));
  const work = await inspectSubscriptionAgentWork(options.count);
  console.log(
    `[subscription-agent] 기존 품질 보정 ${work.recoveryIds.length} · 미분석 실행 ${work.analysisIds.length} · `
    + `신규 안전 후보 ${work.newCandidateCount} · 최대 ${options.count}건`,
  );
  if (!options.execute) {
    console.log(
      "[subscription-agent] 계획 확인만 완료했습니다. Gate R 전에는 --execute가 차단되며 이 계획은 실행 권한이 아닙니다.",
    );
    return 0;
  }
  assertAnalysisLabLiveExecutionAdmitted();
  const result = await runSubscriptionAnalysisAgent(options);
  console.log(`\n[subscription-agent] ${result.report.status} · 보고서 ${result.artifactPath}`);
  return result.report.status === "completed" ? 0 : result.report.status === "partial" ? 2 : 1;
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // no-op
  }
}

if (process.argv[1]?.endsWith("subscription-analysis-agent.ts")) {
  main().then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  }).catch(async (error) => {
    console.error("[subscription-agent] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
}
