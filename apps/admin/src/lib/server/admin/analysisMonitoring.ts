import { createHash } from "node:crypto"
import { access, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_INPUT_PREPARATION_STALE_SECONDS,
  DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS,
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
} from "@cunote/contracts"

import type {
  AnalysisInputPreparationMonitoring,
  AnalysisLaunchMonitoring,
  AnalysisLaunchMonitoringTarget,
  AnalysisLaunchTargetStatus,
  AnalysisMonitoringAttention,
  AnalysisMonitoringSnapshot,
  AnalysisPromotionReleaseMonitoring,
  AnalysisServingMonitoring,
  AnalysisWorkerMonitoring,
} from "@/features/analysis-monitoring/contract"
import { getDeepAnalysisRuntimeControlStatus } from "@/lib/server/admin/deepAnalysisRuntimeControl"
import { getAdminSql } from "@/lib/server/db/client"

const SHA256 = /^[a-f0-9]{64}$/
const EMPTY_COUNTS: Record<AnalysisLaunchTargetStatus, number> = {
  pending: 0,
  running: 0,
  publishable: 0,
  held: 0,
  failed: 0,
  skipped: 0,
}

interface WorkerRow {
  worker_id: string | null
  status: string | null
  service_revision: string | null
  metadata: Record<string, unknown> | null
  heartbeat_at: Date | string | null
  stale_seconds: number | null
  active_worker_count: number
  active_lease_count: number
}

interface InputPreparationRow {
  status: string | null
  metadata: Record<string, unknown> | null
  heartbeat_at: Date | string | null
  stale_seconds: number | null
}

interface ServingRow {
  execution_id: string | null
  verified_at: Date | string | null
  stale_seconds: number | null
  expected_items: number
  checked_items: number
  fresh_items: number
  failed_receipts: number
  stale_receipts: number
}

interface ReleaseRow {
  release_id: string
  revision: number
  status: string
  created_at: Date | string
  approved_at: Date | string | null
  started_at: Date | string | null
  completed_at: Date | string | null
  total_items: number
  applied_items: number
  failed_items: number
}

interface GrantMetadataRow {
  id: string
  title: string
  source: string
}

interface LaunchCandidate {
  timestamp: number
  value: AnalysisLaunchMonitoring
}

export async function getAnalysisMonitoringSnapshot(): Promise<AnalysisMonitoringSnapshot> {
  const sql = getAdminSql()
  const launchPromise = readLatestLaunchMonitoring()
  const runtimePromise = getDeepAnalysisRuntimeControlStatus(sql)
  const operationsPromise = readOperationalMonitoring()
  const releasesPromise = readPromotionReleases()

  const launch = await launchPromise
  const grantMetadataPromise = readGrantMetadata(launch.targets.map((target) => target.grantId))
  const [runtime, operations, releases, grantMetadata] = await Promise.all([
    runtimePromise,
    operationsPromise,
    releasesPromise,
    grantMetadataPromise,
  ])
  const launchWithTitles = {
    ...launch,
    targets: launch.targets.map((target) => ({
      ...target,
      title: grantMetadata.get(target.grantId)?.title ?? target.title,
      source: grantMetadata.get(target.grantId)?.source ?? target.source,
    })),
  }
  const snapshot = {
    generatedAt: new Date().toISOString(),
    runtime,
    launch: launchWithTitles,
    releases,
    ...operations,
  }
  return {
    ...snapshot,
    attention: buildAttention(snapshot),
  }
}

async function readOperationalMonitoring(): Promise<{
  worker: AnalysisWorkerMonitoring
  inputPreparation: AnalysisInputPreparationMonitoring
  serving: AnalysisServingMonitoring
}> {
  const sql = getAdminSql()
  const [workerRows, inputRows, servingRows] = await Promise.all([
    sql<WorkerRow[]>`
      WITH workers AS (
        SELECT
          heartbeat.worker_id,
          heartbeat.current_job_id,
          heartbeat.status,
          heartbeat.service_revision,
          heartbeat.metadata,
          heartbeat.heartbeat_at,
          extract(epoch FROM (now() - heartbeat.heartbeat_at))::int AS stale_seconds
        FROM grant_deep_analysis_worker_heartbeats heartbeat
        WHERE heartbeat.worker_id NOT LIKE 'cunote-deep-analysis-input-preparation-%'
      ), active_leases AS (
        SELECT id, worker_id
        FROM grant_deep_analysis_jobs
        WHERE status = 'leased' AND lease_expires_at > now()
      ), active_workers AS (
        SELECT worker.*
        FROM active_leases lease
        JOIN workers worker
          ON worker.current_job_id = lease.id
         AND worker.worker_id = lease.worker_id
         AND worker.status = 'running'
      ), selected AS (
        SELECT ranked.*
        FROM (
          SELECT worker.*, 0 AS priority FROM active_workers worker
          UNION ALL
          SELECT worker.*, 1 AS priority FROM workers worker
        ) ranked
        ORDER BY priority, heartbeat_at DESC
        LIMIT 1
      )
      SELECT
        selected.worker_id,
        selected.status,
        selected.service_revision,
        selected.metadata,
        selected.heartbeat_at,
        selected.stale_seconds,
        (SELECT count(*)::int FROM active_workers) AS active_worker_count,
        (SELECT count(*)::int FROM active_leases) AS active_lease_count
      FROM (SELECT 1) seed
      LEFT JOIN selected ON true
    `,
    sql<InputPreparationRow[]>`
      SELECT
        status,
        metadata,
        heartbeat_at,
        extract(epoch FROM (now() - heartbeat_at))::int AS stale_seconds
      FROM grant_deep_analysis_worker_heartbeats
      WHERE worker_id LIKE 'cunote-deep-analysis-input-preparation-%'
      ORDER BY heartbeat_at DESC
      LIMIT 1
    `,
    sql<ServingRow[]>`
      WITH expected AS (
        SELECT count(*)::int AS expected_items
        FROM analysis_lab_promotion_items item
        JOIN analysis_lab_promotion_releases release ON release.id = item.release_db_id
        WHERE release.status = 'active'
          AND item.status = 'applied'
          AND item.deep_analysis_run_id IS NOT NULL
      ), latest_monitor AS (
        SELECT
          receipt.evidence->>'monitorExecutionId' AS execution_id,
          max(receipt.created_at) AS verified_at
        FROM grant_deep_analysis_stage_receipts receipt
        WHERE receipt.stage = 'publication_complete'
          AND receipt.verifier_version = ${DEEP_ANALYSIS_SERVING_VERIFIER_VERSION}
          AND receipt.evidence->>'observationMode' = 'active_monitor'
          AND receipt.evidence->>'monitorRuntime' = 'cloud_run'
          AND coalesce(receipt.evidence->>'monitorExecutionId', '') <> ''
        GROUP BY receipt.evidence->>'monitorExecutionId'
        ORDER BY verified_at DESC
        LIMIT 1
      ), observed AS (
        SELECT
          count(DISTINCT receipt.evidence->>'promotionItemId')::int AS checked_items,
          count(DISTINCT receipt.evidence->>'promotionItemId') FILTER (
            WHERE receipt.stage = 'analysis_fresh' AND receipt.status = 'passed'
          )::int AS fresh_items,
          count(*) FILTER (WHERE receipt.status = 'failed')::int AS failed_receipts,
          count(*) FILTER (WHERE receipt.status = 'stale')::int AS stale_receipts
        FROM latest_monitor monitor
        JOIN grant_deep_analysis_stage_receipts receipt
          ON receipt.evidence->>'monitorExecutionId' = monitor.execution_id
         AND receipt.verifier_version = ${DEEP_ANALYSIS_SERVING_VERIFIER_VERSION}
         AND receipt.evidence->>'observationMode' = 'active_monitor'
         AND receipt.evidence->>'monitorRuntime' = 'cloud_run'
         AND receipt.stage IN ('publication_complete', 'serving_complete', 'analysis_fresh')
      )
      SELECT
        monitor.execution_id,
        monitor.verified_at,
        extract(epoch FROM (now() - monitor.verified_at))::int AS stale_seconds,
        expected.expected_items,
        coalesce(observed.checked_items, 0)::int AS checked_items,
        coalesce(observed.fresh_items, 0)::int AS fresh_items,
        coalesce(observed.failed_receipts, 0)::int AS failed_receipts,
        coalesce(observed.stale_receipts, 0)::int AS stale_receipts
      FROM expected
      LEFT JOIN latest_monitor monitor ON true
      LEFT JOIN observed ON true
    `,
  ])
  return {
    worker: buildWorker(workerRows[0]),
    inputPreparation: buildInputPreparation(inputRows[0]),
    serving: buildServing(servingRows[0]),
  }
}

async function readPromotionReleases(): Promise<AnalysisPromotionReleaseMonitoring[]> {
  const rows = await getAdminSql()<ReleaseRow[]>`
    SELECT
      release.release_id,
      release.revision,
      release.status,
      release.created_at,
      release.approved_at,
      release.started_at,
      release.completed_at,
      count(item.id)::int AS total_items,
      count(item.id) FILTER (WHERE item.status = 'applied')::int AS applied_items,
      count(item.id) FILTER (WHERE item.status = 'failed')::int AS failed_items
    FROM analysis_lab_promotion_releases release
    LEFT JOIN analysis_lab_promotion_items item ON item.release_db_id = release.id
    GROUP BY release.id
    ORDER BY release.created_at DESC
    LIMIT 8
  `
  return rows.map((row) => ({
    releaseId: row.release_id,
    revision: Number(row.revision),
    status: row.status,
    createdAt: iso(row.created_at)!,
    approvedAt: iso(row.approved_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    totalItems: Number(row.total_items),
    appliedItems: Number(row.applied_items),
    failedItems: Number(row.failed_items),
  }))
}

async function readGrantMetadata(ids: string[]): Promise<Map<string, GrantMetadataRow>> {
  if (ids.length === 0) return new Map()
  const rows = await getAdminSql()<GrantMetadataRow[]>`
    SELECT id, title, source
    FROM grants
    WHERE id = ANY(${ids}::uuid[])
  `
  return new Map(rows.map((row) => [row.id, row]))
}

function buildWorker(row?: WorkerRow): AnalysisWorkerMonitoring {
  const metadata = row?.metadata ?? {}
  const staleSeconds = nullableNumber(row?.stale_seconds)
  const activeWorkerCount = number(row?.active_worker_count)
  const activeLeaseCount = number(row?.active_lease_count)
  const executionMode = metadata.executionMode === "observe_only"
    ? "observe_only"
    : metadata.executionMode === "active" ? "active" : null
  return {
    workerId: row?.worker_id ?? null,
    status: row?.status ?? null,
    executionMode,
    claimScope: typeof metadata.claimScope === "string" ? metadata.claimScope : null,
    serviceRevision: row?.service_revision ?? null,
    heartbeatAt: iso(row?.heartbeat_at),
    staleSeconds,
    activeWorkerCount,
    activeLeaseCount,
    healthy: Boolean(row)
      && (row?.status === "idle" || row?.status === "running")
      && staleSeconds !== null
      && staleSeconds <= DEEP_ANALYSIS_DEFAULT_LIMITS.heartbeatStaleSeconds
      && activeWorkerCount === activeLeaseCount,
  }
}

function buildInputPreparation(row?: InputPreparationRow): AnalysisInputPreparationMonitoring {
  const metadata = row?.metadata ?? {}
  const staleSeconds = nullableNumber(row?.stale_seconds)
  const failedCount = number(metadata.archiveFailedCount)
    + number(metadata.conversionFailedCount)
    + number(metadata.pdfRecoveryFailedCount)
  return {
    status: row?.status ?? null,
    heartbeatAt: iso(row?.heartbeat_at),
    staleSeconds,
    targetCount: number(metadata.targetCount),
    sealedCount: number(metadata.sealedCount),
    unresolvedCount: number(metadata.unresolvedCount),
    failedCount,
    healthy: Boolean(row)
      && (row?.status === "idle" || row?.status === "running")
      && staleSeconds !== null
      && staleSeconds <= DEEP_ANALYSIS_INPUT_PREPARATION_STALE_SECONDS
      && failedCount === 0,
  }
}

function buildServing(row?: ServingRow): AnalysisServingMonitoring {
  const staleSeconds = nullableNumber(row?.stale_seconds)
  const expectedItems = number(row?.expected_items)
  const checkedItems = number(row?.checked_items)
  const freshItems = number(row?.fresh_items)
  const failedReceipts = number(row?.failed_receipts)
  const staleReceipts = number(row?.stale_receipts)
  return {
    executionId: row?.execution_id ?? null,
    verifiedAt: iso(row?.verified_at),
    staleSeconds,
    expectedItems,
    checkedItems,
    freshItems,
    failedReceipts,
    staleReceipts,
    healthy: staleSeconds !== null
      && staleSeconds <= DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS
      && expectedItems > 0
      && checkedItems === expectedItems
      && freshItems === expectedItems
      && failedReceipts === 0
      && staleReceipts === 0,
  }
}

function buildAttention(input: Omit<AnalysisMonitoringSnapshot, "attention">): AnalysisMonitoringAttention[] {
  const items: AnalysisMonitoringAttention[] = []
  if (!input.launch.available) {
    items.push({
      id: "local-artifacts-unavailable",
      severity: "info",
      title: "로컬 launch 산출물을 읽을 수 없습니다",
      description: "배포된 ops에서는 DB 기반 release·serving 상태만 표시됩니다.",
    })
  }
  if (input.launch.systemicFailure) {
    items.push({
      id: "launch-systemic-failure",
      severity: "critical",
      title: "launch 공유 실행 경로가 중단됐습니다",
      description: input.launch.systemicFailure,
    })
  }
  if (input.launch.summary.failed > 0 || input.launch.summary.held > 0) {
    items.push({
      id: "launch-isolated-targets",
      severity: input.launch.summary.failed > 0 ? "critical" : "warning",
      title: "격리된 launch 대상이 있습니다",
      description: `실패 ${input.launch.summary.failed}건 · 보류 ${input.launch.summary.held}건`,
    })
  }
  if (input.runtime.activeDeepLeases > 0 && input.runtime.effectiveMode === "paused") {
    items.push({
      id: "runtime-lease-conflict",
      severity: "critical",
      title: "paused 상태에 활성 lease가 남아 있습니다",
      description: `Deep ${input.runtime.activeDeepLeases}건 · Kordoc ${input.runtime.activeApplicationLeases}건`,
    })
  }
  if (!input.worker.healthy) {
    items.push({
      id: "worker-unhealthy",
      severity: "warning",
      title: "운영 worker heartbeat를 확인해야 합니다",
      description: `상태 ${input.worker.status ?? "없음"} · 모드 ${input.worker.executionMode ?? "없음"} · lease ${input.worker.activeLeaseCount}`,
    })
  }
  if (!input.inputPreparation.healthy) {
    items.push({
      id: "input-preparation-unhealthy",
      severity: "warning",
      title: "입력 준비 worker가 최신 정상 상태가 아닙니다",
      description: `봉인 ${input.inputPreparation.sealedCount}/${input.inputPreparation.targetCount} · 실패 ${input.inputPreparation.failedCount}`,
    })
  }
  const release = input.releases[0]
  if (release && ["partial_failed", "rolling_back"].includes(release.status)) {
    items.push({
      id: "release-attention",
      severity: "critical",
      title: "최근 release를 확인해야 합니다",
      description: `${release.releaseId} · ${release.status}`,
    })
  }
  if (!input.serving.healthy) {
    items.push({
      id: "serving-unhealthy",
      severity: "warning",
      title: "서빙 검증이 최신 정상 상태가 아닙니다",
      description: `정상 ${input.serving.freshItems}/${input.serving.expectedItems} · 실패 ${input.serving.failedReceipts} · stale ${input.serving.staleReceipts}`,
    })
  }
  return items
}

export async function readLatestLaunchMonitoring(
  repositoryRoot?: string,
): Promise<AnalysisLaunchMonitoring> {
  const root = repositoryRoot ?? await findRepositoryRoot()
  if (!root) return emptyLaunch(false)
  const launchRoot = join(root, "spike-out", "analysis-lab", "launch")
  try {
    await access(launchRoot)
  } catch {
    return emptyLaunch(false)
  }
  const [statusRecord, receiptRecord, grantRecord, manifestRecord] = await Promise.all([
    readLatestMutable(join(launchRoot, "status"), "updatedAt"),
    readLatestImmutable(join(launchRoot, "receipts"), "finishedAt"),
    readLatestImmutable(join(launchRoot, "grants"), "approvedAt"),
    readLatestImmutable(join(launchRoot, "manifests"), "preparedAt"),
  ])
  const candidates: LaunchCandidate[] = []
  if (manifestRecord) {
    candidates.push({
      timestamp: timestamp(manifestRecord.value.preparedAt),
      value: fromPreparedManifest(manifestRecord.sha256, manifestRecord.value),
    })
  }
  if (grantRecord) {
    const manifestSha256 = string(grantRecord.value.manifestSha256)
    const manifest = manifestSha256
      ? await readImmutable(join(launchRoot, "manifests"), manifestSha256)
      : null
    if (manifest) {
      candidates.push({
        timestamp: timestamp(grantRecord.value.approvedAt),
        value: fromApprovedGrant(grantRecord.sha256, grantRecord.value, manifestSha256!, manifest),
      })
    }
  }
  if (receiptRecord) {
    const manifestSha256 = string(receiptRecord.value.manifestSha256)
    const grantSha256 = string(receiptRecord.value.grantSha256)
    const [manifest, grant] = await Promise.all([
      manifestSha256 ? readImmutable(join(launchRoot, "manifests"), manifestSha256) : null,
      grantSha256 ? readImmutable(join(launchRoot, "grants"), grantSha256) : null,
    ])
    if (manifest) {
      candidates.push({
        timestamp: timestamp(receiptRecord.value.finishedAt),
        value: fromReceipt(receiptRecord.sha256, receiptRecord.value, manifest, grant),
      })
    }
  }
  if (statusRecord) {
    const manifestSha256 = string(statusRecord.value.manifestSha256)
    const manifest = manifestSha256
      ? await readImmutable(join(launchRoot, "manifests"), manifestSha256)
      : null
    if (manifest) {
      candidates.push({
        timestamp: timestamp(statusRecord.value.updatedAt),
        value: fromStatus(statusRecord.value, manifest),
      })
    }
  }
  return candidates.reduce<LaunchCandidate | null>(
    (latest, candidate) => !latest || candidate.timestamp > latest.timestamp ? candidate : latest,
    null,
  )?.value ?? emptyLaunch(true)
}

function fromPreparedManifest(manifestSha256: string, manifest: Record<string, unknown>): AnalysisLaunchMonitoring {
  return fromManifestBase(manifestSha256, manifest, {
    state: "prepared",
    grantSha256: null,
    receiptSha256: null,
    approvedAt: null,
    startedAt: null,
    updatedAt: string(manifest.preparedAt),
    finishedAt: null,
    stopReason: null,
    systemicFailure: null,
  })
}

function fromApprovedGrant(
  grantSha256: string,
  grant: Record<string, unknown>,
  manifestSha256: string,
  manifest: Record<string, unknown>,
): AnalysisLaunchMonitoring {
  return fromManifestBase(manifestSha256, manifest, {
    state: "approved",
    grantSha256,
    receiptSha256: null,
    approvedAt: string(grant.approvedAt),
    startedAt: null,
    updatedAt: string(grant.approvedAt),
    finishedAt: null,
    stopReason: null,
    systemicFailure: null,
  })
}

function fromReceipt(
  receiptSha256: string,
  receipt: Record<string, unknown>,
  manifest: Record<string, unknown>,
  grant: Record<string, unknown> | null,
): AnalysisLaunchMonitoring {
  const manifestSha256 = string(receipt.manifestSha256)!
  const base = fromManifestBase(manifestSha256, manifest, {
    state: "finished",
    grantSha256: string(receipt.grantSha256),
    receiptSha256,
    approvedAt: string(grant?.approvedAt),
    startedAt: string(receipt.startedAt),
    updatedAt: string(receipt.finishedAt),
    finishedAt: string(receipt.finishedAt),
    stopReason: string(receipt.stopReason),
    systemicFailure: string(receipt.systemicFailure),
  })
  const manifestTargets = targetMap(manifest)
  const targets = array(receipt.targets).map((raw): AnalysisLaunchMonitoringTarget => {
    const target = record(raw)
    const grantId = string(target.grantId) ?? "unknown"
    const material = manifestTargets.get(grantId)
    return {
      sequence: number(target.sequence),
      grantId,
      title: null,
      source: null,
      stratum: string(material?.stratum) ?? "unknown",
      status: targetStatus(target.status),
      applicationRoundtripStatus: string(target.applicationRoundtripStatus),
      startedAt: null,
      finishedAt: string(receipt.finishedAt),
      error: string(target.error),
    }
  })
  return { ...base, summary: countTargets(targets), targets }
}

function fromStatus(
  status: Record<string, unknown>,
  manifest: Record<string, unknown>,
): AnalysisLaunchMonitoring {
  const manifestSha256 = string(status.manifestSha256)!
  const base = fromManifestBase(manifestSha256, manifest, {
    state: status.lifecycle === "finished" ? "finished" : "running",
    grantSha256: string(status.grantSha256),
    receiptSha256: string(status.receiptSha256),
    approvedAt: null,
    startedAt: string(status.startedAt),
    updatedAt: string(status.updatedAt),
    finishedAt: string(status.finishedAt),
    stopReason: string(status.stopReason),
    systemicFailure: string(status.systemicFailure),
  })
  const targets = array(status.targets).map((raw): AnalysisLaunchMonitoringTarget => {
    const target = record(raw)
    return {
      sequence: number(target.sequence),
      grantId: string(target.grantId) ?? "unknown",
      title: string(target.title),
      source: null,
      stratum: string(target.stratum) ?? "unknown",
      status: targetStatus(target.status),
      applicationRoundtripStatus: string(target.applicationRoundtripStatus),
      startedAt: string(target.startedAt),
      finishedAt: string(target.finishedAt),
      error: string(target.error),
    }
  })
  return { ...base, summary: countTargets(targets), targets }
}

function fromManifestBase(
  manifestSha256: string,
  manifest: Record<string, unknown>,
  phase: Omit<AnalysisLaunchMonitoring, "available" | "seriesId" | "manifestSha256" | "preparedAt" | "model" | "concurrency" | "withApplicationRoundtrip" | "summary" | "targets">,
): AnalysisLaunchMonitoring {
  const source = record(manifest.source)
  const execution = record(manifest.execution)
  const targets = array(manifest.targets).map((raw): AnalysisLaunchMonitoringTarget => {
    const target = record(raw)
    return {
      sequence: number(target.sequence),
      grantId: string(target.grantId) ?? "unknown",
      title: null,
      source: null,
      stratum: string(target.stratum) ?? "unknown",
      status: "pending",
      applicationRoundtripStatus: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    }
  })
  return {
    available: true,
    seriesId: string(source.seriesId),
    manifestSha256,
    preparedAt: string(manifest.preparedAt),
    model: string(execution.model),
    concurrency: nullableNumber(execution.concurrency),
    withApplicationRoundtrip: execution.withApplicationRoundtrip === true,
    summary: countTargets(targets),
    targets,
    ...phase,
  }
}

async function findRepositoryRoot(): Promise<string | null> {
  let cursor = process.cwd()
  for (;;) {
    try {
      await access(join(cursor, "pnpm-workspace.yaml"))
      return cursor
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return null
      cursor = parent
    }
  }
}

async function readLatestMutable(
  directory: string,
  timestampKey: string,
): Promise<{ value: Record<string, unknown> } | null> {
  return readLatest(directory, timestampKey, false)
}

async function readLatestImmutable(
  directory: string,
  timestampKey: string,
): Promise<{ sha256: string; value: Record<string, unknown> } | null> {
  const found = await readLatest(directory, timestampKey, true)
  return found && "sha256" in found ? found : null
}

async function readLatest(
  directory: string,
  timestampKey: string,
  immutable: boolean,
): Promise<{ sha256: string; value: Record<string, unknown> } | { value: Record<string, unknown> } | null> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return null
  }
  const values = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const sha256 = name.slice(0, -5)
    if (!SHA256.test(sha256)) return null
    try {
      const bytes = await readFile(join(directory, name))
      if (immutable && createHash("sha256").update(bytes).digest("hex") !== sha256) return null
      const value = record(JSON.parse(bytes.toString("utf8")))
      return { sha256, value, timestamp: timestamp(value[timestampKey]) }
    } catch {
      return null
    }
  }))
  const latest = values.reduce<(NonNullable<(typeof values)[number]>) | null>(
    (current, candidate) => candidate && (!current || candidate.timestamp > current.timestamp)
      ? candidate
      : current,
    null,
  )
  if (!latest) return null
  return immutable
    ? { sha256: latest.sha256, value: latest.value }
    : { value: latest.value }
}

async function readImmutable(directory: string, sha256: string): Promise<Record<string, unknown> | null> {
  if (!SHA256.test(sha256)) return null
  try {
    const bytes = await readFile(join(directory, `${sha256}.json`))
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) return null
    return record(JSON.parse(bytes.toString("utf8")))
  } catch {
    return null
  }
}

function emptyLaunch(available: boolean): AnalysisLaunchMonitoring {
  return {
    available,
    state: "unavailable",
    seriesId: null,
    manifestSha256: null,
    grantSha256: null,
    receiptSha256: null,
    preparedAt: null,
    approvedAt: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    stopReason: null,
    systemicFailure: null,
    model: null,
    concurrency: null,
    withApplicationRoundtrip: false,
    summary: { ...EMPTY_COUNTS },
    targets: [],
  }
}

function targetMap(manifest: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return new Map(array(manifest.targets).map((raw) => {
    const target = record(raw)
    return [string(target.grantId) ?? "unknown", target]
  }))
}

function countTargets(targets: AnalysisLaunchMonitoringTarget[]): Record<AnalysisLaunchTargetStatus, number> {
  const counts = { ...EMPTY_COUNTS }
  for (const target of targets) counts[target.status] += 1
  return counts
}

function targetStatus(value: unknown): AnalysisLaunchTargetStatus {
  return value === "running"
    || value === "publishable"
    || value === "held"
    || value === "failed"
    || value === "skipped"
    ? value
    : "pending"
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0
}

function nullableNumber(value: unknown): number | null {
  const parsed = number(value)
  return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
