import { execFileSync, spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  openSync,
} from "node:fs"
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import type {
  SubscriptionAgentBatchSnapshot,
  SubscriptionAgentOpsOptions,
  SubscriptionAgentOpsPlan,
  SubscriptionAgentOpsRuntime,
  SubscriptionAgentOpsSnapshot,
  SubscriptionAgentOpsStage,
  SubscriptionAgentReportSummary,
} from "@/features/subscription-agent/contract"

const RUNTIME_VERSION = "subscription-agent-ops-v1" as const
const DEFAULT_OPTIONS: SubscriptionAgentOpsOptions = {
  count: 30,
  maxCycles: 3,
  concurrency: 2,
  maxCostUsd: 65,
}
const MAX_LOG_LINES = 160
const MAX_HISTORY = 12
const ACTIVE_STATES = new Set(["planning", "running", "stopping"])
const COMMAND_STAGES = [
  ["신규 모집 공고 자동 선정", "selecting"],
  ["딥분석·Kordoc 병렬 실행", "analyzing"],
  ["Fable 독립 검수", "reviewing"],
  ["Sonnet 블라인드 감사", "auditing"],
  ["Opus 충돌 3차 판정", "adjudicating"],
  ["신청자격 blocker 누적 교정", "repairing"],
  ["Kordoc 품질 재분석", "repairing"],
  ["22축 계약 재분석", "repairing"],
] as const satisfies ReadonlyArray<readonly [string, SubscriptionAgentOpsStage]>

export class SubscriptionAgentOpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
  ) {
    super(message)
    this.name = "SubscriptionAgentOpsError"
  }
}

interface PersistedRuntime {
  version: typeof RUNTIME_VERSION
  runId: string
  state: "running" | "stopping" | "completed" | "partial" | "failed"
  pid: number
  startedAt: string
  finishedAt: string | null
  options: SubscriptionAgentOpsOptions
  logFile: string
  error: string | null
}

export async function getSubscriptionAgentOpsSnapshot(input: {
  localAvailable: boolean
}): Promise<SubscriptionAgentOpsSnapshot> {
  const root = findRepositoryRoot()
  const [plan, history, batch, persisted] = await Promise.all([
    readPlan(root),
    readReportHistory(root),
    readBatchSnapshot(root),
    readRuntime(root),
  ])
  const reconciled = await reconcileRuntime(root, persisted, history)
  const runtime = await runtimeView(reconciled)
  const latestReport = history[0] ?? null
  return {
    refreshedAt: new Date().toISOString(),
    localAvailable: input.localAvailable,
    executionAllowed: input.localAvailable && !ACTIVE_STATES.has(runtime.state),
    runtime,
    plan,
    batch,
    latestReport,
    history,
    nextAction: buildNextAction({
      localAvailable: input.localAvailable,
      runtime,
      plan,
      latestReport,
    }),
  }
}

export async function planSubscriptionAgentRun(input: {
  count: 5 | 10 | 30
  localAvailable: boolean
}): Promise<SubscriptionAgentOpsSnapshot> {
  requireLocal(input.localAvailable)
  const root = findRepositoryRoot()
  assertNoActiveRuntime(await readRuntime(root))
  const output = await runPlanCommand(root, input.count)
  const plan = parseSubscriptionAgentPlanOutput(output, new Date())
  await writeJsonAtomic(planFile(root), plan)
  return getSubscriptionAgentOpsSnapshot({ localAvailable: true })
}

export async function startSubscriptionAgentRun(input: {
  count: 5 | 10 | 30
  localAvailable: boolean
}): Promise<SubscriptionAgentOpsSnapshot> {
  requireLocal(input.localAvailable)
  const root = findRepositoryRoot()
  assertNoActiveRuntime(await readRuntime(root))

  const { getDeepAnalysisRuntimeControlStatus } = await import("./deepAnalysisRuntimeControl")
  const control = await getDeepAnalysisRuntimeControlStatus()
  if (control.effectiveMode === "production_api") {
    throw new SubscriptionAgentOpsError(
      "production_automation_active",
      "운영 API 자동화가 켜져 있습니다. /pipeline에서 먼저 일시정지하세요.",
      409,
    )
  }
  if (control.effectiveMode === "local_subscription") {
    throw new SubscriptionAgentOpsError(
      "local_subscription_busy",
      "다른 로컬 구독 분석이 권한을 사용 중입니다. 기존 실행이 끝난 뒤 다시 시도하세요.",
      409,
    )
  }

  const options: SubscriptionAgentOpsOptions = { ...DEFAULT_OPTIONS, count: input.count }
  const processSpec = buildSubscriptionAgentProcessSpec(options)
  const startedAt = new Date()
  const runId = `ops-${startedAt.toISOString().replace(/[:.]/g, "")}-${process.pid}`
  const logFile = join(agentOpsDir(root), `${runId}.log`)
  await mkdir(dirname(logFile), { recursive: true })
  const logFd = openSync(logFile, "a", 0o600)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(
      processSpec.command,
      processSpec.args,
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFd, logFd],
        env: { ...subscriptionAgentEnv(), ...processSpec.envOverrides },
      },
    )
  } finally {
    closeSync(logFd)
  }
  if (!child.pid) {
    throw new SubscriptionAgentOpsError("agent_spawn_failed", "구독 분석 에이전트 프로세스를 시작하지 못했습니다.")
  }

  const runtime: PersistedRuntime = {
    version: RUNTIME_VERSION,
    runId,
    state: "running",
    pid: child.pid,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    options,
    logFile,
    error: null,
  }
  await writeJsonAtomic(runtimeFile(root), runtime)
  child.once("error", (error) => {
    void writeJsonAtomic(runtimeFile(root), {
      ...runtime,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: error.message,
    }).catch(() => undefined)
  })
  child.unref()
  return getSubscriptionAgentOpsSnapshot({ localAvailable: true })
}

export async function stopSubscriptionAgentRun(input: {
  localAvailable: boolean
}): Promise<SubscriptionAgentOpsSnapshot> {
  requireLocal(input.localAvailable)
  const root = findRepositoryRoot()
  const runtime = await readRuntime(root)
  if (!runtime || !ACTIVE_STATES.has(runtime.state)) {
    throw new SubscriptionAgentOpsError("agent_not_running", "중단할 구독 분석 에이전트가 없습니다.", 409)
  }
  if (!isExpectedAgentProcess(runtime.pid)) {
    const failed = {
      ...runtime,
      state: "failed" as const,
      finishedAt: new Date().toISOString(),
      error: "기록된 PID에서 구독 분석 에이전트를 확인하지 못했습니다.",
    }
    await writeJsonAtomic(runtimeFile(root), failed)
    throw new SubscriptionAgentOpsError("agent_process_mismatch", failed.error, 409)
  }

  if (process.platform === "win32") process.kill(runtime.pid, "SIGTERM")
  else process.kill(-runtime.pid, "SIGTERM")
  await writeJsonAtomic(runtimeFile(root), { ...runtime, state: "stopping" })
  return getSubscriptionAgentOpsSnapshot({ localAvailable: true })
}

export function parseSubscriptionAgentPlanOutput(
  output: string,
  generatedAt = new Date(),
): SubscriptionAgentOpsPlan {
  const match = output.match(
    /기존 품질 보정\s+(\d+)\s+·\s+미분석 실행\s+(\d+)\s+·\s+신규 안전 후보\s+(\d+)\s+·\s+최대\s+(\d+)건/,
  )
  if (!match) {
    throw new SubscriptionAgentOpsError(
      "agent_plan_unreadable",
      "에이전트 계획 출력에서 작업 수를 읽지 못했습니다.",
      500,
    )
  }
  return {
    generatedAt: generatedAt.toISOString(),
    recoveryCount: Number(match[1]),
    analysisCount: Number(match[2]),
    newCandidateCount: Number(match[3]),
    count: Number(match[4]),
  }
}

export function buildSubscriptionAgentProcessSpec(options: SubscriptionAgentOpsOptions): {
  command: "pnpm"
  args: string[]
  envOverrides: Record<string, string>
} {
  return {
    command: "pnpm",
    args: [
      "lab:agent",
      "--",
      `--count=${options.count}`,
      `--max-cycles=${options.maxCycles}`,
      `--concurrency=${options.concurrency}`,
      `--max-cost-usd=${options.maxCostUsd}`,
      "--execute",
    ],
    envOverrides: {
      ANALYSIS_LAB_TRANSPORT: "claude-cli",
      ANALYSIS_LAB_MODEL: "claude-opus-5",
      ANALYSIS_LAB_ROUNDTRIP_MODEL: "claude-opus-5",
      ANTHROPIC_API_KEY: "",
    },
  }
}

export function inferSubscriptionAgentStage(
  lines: readonly string[],
  finalState?: PersistedRuntime["state"],
): SubscriptionAgentOpsStage {
  if (finalState && !ACTIVE_STATES.has(finalState)) return "finished"
  let stage: SubscriptionAgentOpsStage = "starting"
  for (const line of lines) {
    for (const [label, candidate] of COMMAND_STAGES) {
      if (line.includes(label)) stage = candidate
    }
  }
  return stage
}

export function summarizeSubscriptionAgentReport(value: unknown): SubscriptionAgentReportSummary | null {
  if (!isRecord(value)) return null
  if (
    typeof value.agentId !== "string"
    || (value.status !== "completed" && value.status !== "partial" && value.status !== "failed")
    || typeof value.startedAt !== "string"
    || typeof value.finishedAt !== "string"
  ) return null
  const cycles = Array.isArray(value.cycles) ? value.cycles : []
  const lastDecision = cycles.length > 0 && isRecord(cycles.at(-1))
    ? (cycles.at(-1) as Record<string, unknown>).decision
    : null
  const decision = isRecord(lastDecision) ? lastDecision : {}
  const startedAt = new Date(value.startedAt)
  const finishedAt = new Date(value.finishedAt)
  return {
    agentId: value.agentId,
    status: value.status,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()) || 0,
    selectedNewCount: arrayLength(value.selectedNewTargets),
    analyzedCount: arrayLength(value.analyzedTargets),
    resumedCount: arrayLength(value.resumedQualityTargets),
    cycleCount: cycles.length,
    completedCount: arrayLength(decision.completed),
    eligibilityRepairCount: arrayLength(decision.eligibilityRepair),
    applicationRetryCount: arrayLength(decision.applicationRetry),
    deepRetryCount: arrayLength(decision.deepRetry),
    blockedCount: arrayLength(decision.blocked),
    blockers: Array.isArray(decision.blocked)
      ? decision.blocked.flatMap((item) => {
        if (!isRecord(item) || typeof item.grantId !== "string") return []
        return [{ grantId: item.grantId, reasons: stringArray(item.reasons) }]
      })
      : [],
    commandLabels: stringArray(value.commandLabels),
    error: typeof value.error === "string" ? value.error : null,
  }
}

async function reconcileRuntime(
  root: string,
  runtime: PersistedRuntime | null,
  history: SubscriptionAgentReportSummary[],
): Promise<PersistedRuntime | null> {
  if (!runtime || !ACTIVE_STATES.has(runtime.state)) return runtime
  if (isExpectedAgentProcess(runtime.pid)) return runtime
  const report = history.find((item) => (
    new Date(item.startedAt).getTime() >= new Date(runtime.startedAt).getTime() - 5_000
  ))
  const reconciled: PersistedRuntime = {
    ...runtime,
    state: report?.status ?? "failed",
    finishedAt: report?.finishedAt ?? new Date().toISOString(),
    error: report?.error ?? (report ? null : "에이전트 프로세스가 보고서 없이 종료됐습니다."),
  }
  await writeJsonAtomic(runtimeFile(root), reconciled)
  return reconciled
}

async function runtimeView(runtime: PersistedRuntime | null): Promise<SubscriptionAgentOpsRuntime> {
  if (!runtime) {
    return {
      version: RUNTIME_VERSION,
      runId: null,
      state: "idle",
      stage: "idle",
      pid: null,
      startedAt: null,
      finishedAt: null,
      options: null,
      observedCommands: [],
      logLines: [],
      error: null,
    }
  }
  const logLines = await readLogLines(runtime.logFile)
  return {
    version: runtime.version,
    runId: runtime.runId,
    state: runtime.state,
    stage: inferSubscriptionAgentStage(logLines, runtime.state),
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    finishedAt: runtime.finishedAt,
    options: runtime.options,
    observedCommands: COMMAND_STAGES
      .filter(([label]) => logLines.some((line) => line.includes(label)))
      .map(([label]) => label),
    logLines,
    error: runtime.error,
  }
}

async function readRuntime(root: string): Promise<PersistedRuntime | null> {
  const value = await readJson(runtimeFile(root))
  if (!isRecord(value) || value.version !== RUNTIME_VERSION) return null
  if (
    typeof value.runId !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "string"
    || !isRecord(value.options)
    || typeof value.logFile !== "string"
    || (value.state !== "running" && value.state !== "stopping" && value.state !== "completed"
      && value.state !== "partial" && value.state !== "failed")
  ) return null
  return value as unknown as PersistedRuntime
}

async function readPlan(root: string): Promise<SubscriptionAgentOpsPlan | null> {
  const value = await readJson(planFile(root))
  if (!isRecord(value)) return null
  if (
    typeof value.generatedAt !== "string"
    || typeof value.count !== "number"
    || typeof value.recoveryCount !== "number"
    || typeof value.analysisCount !== "number"
    || typeof value.newCandidateCount !== "number"
  ) return null
  return value as unknown as SubscriptionAgentOpsPlan
}

async function readReportHistory(root: string): Promise<SubscriptionAgentReportSummary[]> {
  const directory = join(analysisLabDir(root), "agent-runs")
  let names: string[]
  try {
    names = (await readdir(/*turbopackIgnore: true*/ directory))
      .filter((name) => name.startsWith("agent-") && name.endsWith(".json"))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_HISTORY)
  } catch {
    return []
  }
  const reports = await Promise.all(names.map(async (name) => (
    summarizeSubscriptionAgentReport(await readJson(join(directory, name)))
  )))
  return reports.filter((report): report is SubscriptionAgentReportSummary => report !== null)
}

async function readBatchSnapshot(root: string): Promise<SubscriptionAgentBatchSnapshot> {
  const value = await readJson(join(analysisLabDir(root), "batch-job.json"))
  if (!isRecord(value)) return idleBatch()
  const progress = isRecord(value.progress) ? value.progress : {}
  const summary = isRecord(value.summary) ? value.summary : {}
  const options = isRecord(value.options) ? value.options : {}
  const state = value.state === "running" || value.state === "finished" || value.state === "aborted" || value.state === "error"
    ? value.state
    : "idle"
  return {
    state,
    jobId: typeof value.jobId === "string" ? value.jobId : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
    total: numberValue(progress.total),
    started: numberValue(progress.started),
    ok: numberValue(progress.ok),
    error: numberValue(progress.error),
    nominalCostUsd: numberValue(progress.cumulativeCostUsd),
    stopReason: typeof summary.stopReason === "string" ? summary.stopReason : null,
    transport: typeof options.transport === "string" ? options.transport : null,
    model: typeof options.model === "string" ? options.model : null,
  }
}

function idleBatch(): SubscriptionAgentBatchSnapshot {
  return {
    state: "idle",
    jobId: null,
    startedAt: null,
    finishedAt: null,
    total: 0,
    started: 0,
    ok: 0,
    error: 0,
    nominalCostUsd: 0,
    stopReason: null,
    transport: null,
    model: null,
  }
}

async function runPlanCommand(root: string, count: number): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("pnpm", ["lab:agent", "--", `--count=${count}`], {
      cwd: root,
      env: subscriptionAgentEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new SubscriptionAgentOpsError("agent_plan_timeout", "에이전트 계획 확인이 60초를 넘겼습니다.", 504))
    }, 60_000)
    child.stdout?.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(new SubscriptionAgentOpsError("agent_plan_failed", error.message))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolveOutput(`${stdout}\n${stderr}`)
      else reject(new SubscriptionAgentOpsError(
        "agent_plan_failed",
        stderr.trim() || `에이전트 계획 확인이 exit ${code ?? "null"}로 실패했습니다.`,
      ))
    })
  })
}

function subscriptionAgentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANALYSIS_LAB_TRANSPORT: "claude-cli",
    ANALYSIS_LAB_MODEL: "claude-opus-5",
    ANALYSIS_LAB_ROUNDTRIP_MODEL: "claude-opus-5",
    ANALYSIS_LAB_TIMEOUT_MS: process.env.ANALYSIS_LAB_TIMEOUT_MS?.trim() || "900000",
    ANTHROPIC_API_KEY: "",
  }
}

function assertNoActiveRuntime(runtime: PersistedRuntime | null): void {
  if (runtime && ACTIVE_STATES.has(runtime.state) && isExpectedAgentProcess(runtime.pid)) {
    throw new SubscriptionAgentOpsError("agent_busy", "구독 분석 에이전트가 이미 실행 중입니다.", 409)
  }
}

function isExpectedAgentProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    })
    return command.includes("subscription-analysis-agent.ts") || command.includes("pnpm lab:agent")
  } catch {
    return false
  }
}

function buildNextAction(input: {
  localAvailable: boolean
  runtime: SubscriptionAgentOpsRuntime
  plan: SubscriptionAgentOpsPlan | null
  latestReport: SubscriptionAgentReportSummary | null
}): SubscriptionAgentOpsSnapshot["nextAction"] {
  if (!input.localAvailable) {
    return {
      title: "로컬 ops에서 열어주세요",
      description: "실행과 중단은 127.0.0.1 또는 dev-ops.changupnote.com의 개발 서버에서만 허용됩니다.",
      tone: "destructive",
    }
  }
  if (ACTIVE_STATES.has(input.runtime.state)) {
    return {
      title: `${stageLabel(input.runtime.stage)} 진행 중`,
      description: "새 실행을 겹치지 말고 현재 단계와 실시간 로그를 확인하세요.",
      tone: "default",
    }
  }
  if (input.runtime.state === "failed") {
    return {
      title: "실패 원인을 확인하고 같은 에이전트를 재실행하세요",
      description: input.runtime.error ?? "실시간 로그의 마지막 오류와 품질 그래프 blocker를 확인하세요.",
      tone: "destructive",
    }
  }
  if (input.latestReport?.status === "partial") {
    return {
      title: "남은 blocker만 다음 실행에서 복구합니다",
      description: `Kordoc ${input.latestReport.applicationRetryCount} · 22축 ${input.latestReport.deepRetryCount} · 기타 차단 ${input.latestReport.blockedCount}건`,
      tone: "default",
    }
  }
  if (input.plan) {
    const immediate = input.plan.recoveryCount + input.plan.analysisCount
    return {
      title: immediate > 0 ? `지금 ${immediate}건을 처리할 수 있습니다` : "새 모집 공고를 자동 선정할 수 있습니다",
      description: `기존 보정 ${input.plan.recoveryCount} · 미분석 ${input.plan.analysisCount} · 신규 후보 ${input.plan.newCandidateCount}건`,
      tone: "default",
    }
  }
  return {
    title: "먼저 실행 계획을 확인하세요",
    description: "모델 호출 없이 기존 보정·미분석·신규 후보 수를 계산합니다.",
    tone: "default",
  }
}

function stageLabel(stage: SubscriptionAgentOpsStage): string {
  return ({
    idle: "대기",
    planning: "계획 계산",
    starting: "시작 준비",
    selecting: "신규 공고 선정",
    analyzing: "딥분석·Kordoc",
    reviewing: "Fable 검수",
    auditing: "Sonnet 감사",
    adjudicating: "Opus 충돌 판정",
    repairing: "원인별 보정",
    finished: "종결",
  })[stage]
}

function findRepositoryRoot(): string {
  let cursor = resolve(/*turbopackIgnore: true*/ process.cwd())
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml")) && existsSync(join(cursor, "package.json"))) {
      return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new SubscriptionAgentOpsError("repository_root_not_found", "Cunote 저장소 루트를 찾지 못했습니다.")
}

function analysisLabDir(root: string): string {
  return join(root, "spike-out", "analysis-lab")
}

function agentOpsDir(root: string): string {
  return join(analysisLabDir(root), "agent-ops")
}

function runtimeFile(root: string): string {
  return join(agentOpsDir(root), "runtime.json")
}

function planFile(root: string): string {
  return join(agentOpsDir(root), "plan.json")
}

async function readLogLines(path: string): Promise<string[]> {
  try {
    const content = await readFile(/*turbopackIgnore: true*/ path, "utf8")
    return content.split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_LINES)
  } catch {
    return []
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ path, "utf8"))
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

function requireLocal(localAvailable: boolean): void {
  if (!localAvailable) {
    throw new SubscriptionAgentOpsError(
      "local_agent_only",
      "구독 분석 에이전트는 로컬 ops 개발 서버에서만 실행할 수 있습니다.",
      403,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
