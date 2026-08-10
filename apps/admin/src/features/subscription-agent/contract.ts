export type SubscriptionAgentOpsState =
  | "idle"
  | "planning"
  | "running"
  | "stopping"
  | "completed"
  | "partial"
  | "failed"

export type SubscriptionAgentOpsStage =
  | "idle"
  | "planning"
  | "starting"
  | "selecting"
  | "analyzing"
  | "reviewing"
  | "auditing"
  | "adjudicating"
  | "repairing"
  | "finished"

export interface SubscriptionAgentOpsPlan {
  generatedAt: string
  count: number
  recoveryCount: number
  analysisCount: number
  newCandidateCount: number
}

export interface SubscriptionAgentOpsOptions {
  count: 5 | 10 | 30
  maxCycles: number
  concurrency: number
  maxCostUsd: number
}

export interface SubscriptionAgentOpsRuntime {
  version: "subscription-agent-ops-v1"
  runId: string | null
  state: SubscriptionAgentOpsState
  stage: SubscriptionAgentOpsStage
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  options: SubscriptionAgentOpsOptions | null
  observedCommands: string[]
  logLines: string[]
  error: string | null
}

export interface SubscriptionAgentBatchSnapshot {
  state: "idle" | "running" | "finished" | "aborted" | "error"
  jobId: string | null
  startedAt: string | null
  finishedAt: string | null
  total: number
  started: number
  ok: number
  error: number
  nominalCostUsd: number
  stopReason: string | null
  transport: string | null
  model: string | null
}

export interface SubscriptionAgentReportSummary {
  agentId: string
  status: "completed" | "partial" | "failed"
  startedAt: string
  finishedAt: string
  durationMs: number
  selectedNewCount: number
  analyzedCount: number
  resumedCount: number
  cycleCount: number
  completedCount: number
  eligibilityRepairCount: number
  applicationRetryCount: number
  deepRetryCount: number
  blockedCount: number
  blockers: Array<{ grantId: string; reasons: string[] }>
  commandLabels: string[]
  error: string | null
}

export interface SubscriptionAgentOpsSnapshot {
  refreshedAt: string
  localAvailable: boolean
  executionAllowed: boolean
  runtime: SubscriptionAgentOpsRuntime
  plan: SubscriptionAgentOpsPlan | null
  batch: SubscriptionAgentBatchSnapshot
  latestReport: SubscriptionAgentReportSummary | null
  history: SubscriptionAgentReportSummary[]
  nextAction: {
    title: string
    description: string
    tone: "default" | "destructive"
  }
}
