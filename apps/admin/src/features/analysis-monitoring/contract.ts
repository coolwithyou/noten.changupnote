import type { DeepAnalysisRuntimeControlStatus } from "@cunote/contracts"

export type MonitoringSeverity = "info" | "warning" | "critical"

export interface AnalysisMonitoringAttention {
  id: string
  severity: MonitoringSeverity
  title: string
  description: string
}

export type AnalysisLaunchTargetStatus =
  | "pending"
  | "running"
  | "publishable"
  | "held"
  | "failed"
  | "skipped"

export interface AnalysisLaunchMonitoringTarget {
  sequence: number
  grantId: string
  title: string | null
  source: string | null
  stratum: string
  status: AnalysisLaunchTargetStatus
  applicationRoundtripStatus: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface AnalysisLaunchMonitoring {
  available: boolean
  state: "unavailable" | "prepared" | "approved" | "running" | "finished"
  seriesId: string | null
  manifestSha256: string | null
  grantSha256: string | null
  receiptSha256: string | null
  preparedAt: string | null
  approvedAt: string | null
  startedAt: string | null
  updatedAt: string | null
  finishedAt: string | null
  stopReason: string | null
  systemicFailure: string | null
  model: string | null
  concurrency: number | null
  withApplicationRoundtrip: boolean
  summary: Record<AnalysisLaunchTargetStatus, number>
  targets: AnalysisLaunchMonitoringTarget[]
}

export interface AnalysisPromotionReleaseMonitoring {
  releaseId: string
  revision: number
  status: string
  createdAt: string
  approvedAt: string | null
  startedAt: string | null
  completedAt: string | null
  totalItems: number
  appliedItems: number
  failedItems: number
}

export interface AnalysisWorkerMonitoring {
  workerId: string | null
  status: string | null
  executionMode: "active" | "observe_only" | null
  claimScope: string | null
  serviceRevision: string | null
  heartbeatAt: string | null
  staleSeconds: number | null
  activeWorkerCount: number
  activeLeaseCount: number
  healthy: boolean
}

export interface AnalysisInputPreparationMonitoring {
  status: string | null
  heartbeatAt: string | null
  staleSeconds: number | null
  targetCount: number
  sealedCount: number
  unresolvedCount: number
  failedCount: number
  healthy: boolean
}

export interface AnalysisServingMonitoring {
  executionId: string | null
  verifiedAt: string | null
  staleSeconds: number | null
  expectedItems: number
  checkedItems: number
  freshItems: number
  failedReceipts: number
  staleReceipts: number
  healthy: boolean
}

export interface AnalysisMonitoringSnapshot {
  generatedAt: string
  runtime: DeepAnalysisRuntimeControlStatus
  launch: AnalysisLaunchMonitoring
  releases: AnalysisPromotionReleaseMonitoring[]
  worker: AnalysisWorkerMonitoring
  inputPreparation: AnalysisInputPreparationMonitoring
  serving: AnalysisServingMonitoring
  attention: AnalysisMonitoringAttention[]
}
