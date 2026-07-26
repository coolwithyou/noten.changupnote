import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_INPUT_PREPARATION_STALE_SECONDS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS,
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
  DEEP_ANALYSIS_STAGE_KEYS,
  type CriterionDimension,
  type DeepAnalysisAxisStatus,
  type DeepAnalysisStageKey,
  type DeepAnalysisStageStatus,
} from "@cunote/contracts"
import type postgres from "postgres"

import {
  AXIS_LABELS,
  DEEP_PIPELINE_BUCKET_LABELS,
  DEEP_PIPELINE_BUCKETS,
  DEEP_STAGE_LABELS,
  type DeepPipelineAggregateSplitCase,
  type DeepPipelineAdminAction,
  type DeepPipelineAttachment,
  type DeepPipelineAudit,
  type DeepPipelineAxis,
  type DeepPipelineBucket,
  type DeepPipelineException,
  type DeepPipelineNoticeDetail,
  type DeepPipelineNoticeItem,
  type DeepPipelineNoticesResult,
  type DeepPipelinePromotion,
  type DeepPipelineStageReceipt,
  type DeepPipelineSummary,
  isDeepPipelineBucket,
} from "@/features/pipeline/contract"
import { getAdminSql } from "@/lib/server/db/client"

const PAGE_SIZE = 100
const MAX_SEARCH_LENGTH = 100
type PipelineSql = postgres.Sql | postgres.TransactionSql

const DEEP_PIPELINE_BASE_CTE = `
with active_grants as (
  select
    g.*,
    coalesce(g.agency_primary, g.agency_operator, g.agency_jurisdiction) as agency,
    (
      timezone('Asia/Seoul', g.apply_end)::date
      - timezone('Asia/Seoul', now())::date
    )::int as d_day
  from cunote_active_deep_analysis_grants(now()) active
  join grants g on g.id = active.grant_id
),
latest_job as (
  select
    active.id as grant_id,
    job.id,
    job.status,
    job.attempt_count,
    job.source_revision_sha256,
    job.updated_at
  from active_grants active
  left join lateral (
    select candidate.*
    from grant_deep_analysis_jobs candidate
    where candidate.grant_id = active.id
      and candidate.model_policy_version = $1
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) job on true
),
latest_run as (
  select job.grant_id as current_grant_id, run.*
  from latest_job job
  left join lateral (
    select candidate.*
    from grant_deep_analysis_runs candidate
    where candidate.job_id = job.id
    order by candidate.started_at desc, candidate.id desc
    limit 1
  ) run on true
),
latest_receipt as (
  select distinct on (receipt.run_id, receipt.stage)
    receipt.*
  from grant_deep_analysis_stage_receipts receipt
  join latest_run run on run.id = receipt.run_id
  order by receipt.run_id, receipt.stage, receipt.attempt desc, receipt.created_at desc
),
receipt_flags as (
  select
    run.id as run_id,
    bool_or(receipt.stage = 'analysis_complete' and receipt.status = 'passed')
      as analysis_complete,
    bool_or(receipt.stage = 'publication_complete' and receipt.status = 'passed')
      as publication_complete,
    bool_or(receipt.stage = 'serving_complete' and receipt.status = 'passed')
      as serving_complete,
    bool_or(receipt.stage = 'analysis_fresh' and receipt.status = 'passed')
      as analysis_fresh,
    bool_or(receipt.status in ('failed', 'blocked')) as receipt_failed_or_blocked,
    bool_or(receipt.status = 'stale') as receipt_stale
  from latest_run run
  left join latest_receipt receipt on receipt.run_id = run.id
  group by run.id
),
attachment_stats as (
  select
    source,
    source_id,
    count(*)::int as attachment_count,
    count(*) filter (
      where storage_key is not null and sha256 is not null
    )::int as archived_count,
    count(*) filter (
      where markdown_storage_key is not null
        and markdown_sha256 is not null
        and conversion_status = 'converted'
    )::int as converted_count,
    count(*) filter (
      where conversion_status = 'failed'
    )::int as blocked_attachment_count,
    max(updated_at) as latest_attachment_at
  from grant_attachment_archives
  group by source, source_id
),
axis_stats as (
  select
    run_id,
    count(*) filter (where status = 'condition_found')::int as condition_found_count,
    count(*) filter (where status = 'inspected_no_condition')::int as inspected_no_condition_count,
    count(*) filter (where status = 'ambiguous')::int as ambiguous_count,
    count(*) filter (where status = 'input_missing')::int as input_missing_count,
    count(*) filter (where status = 'unassessed')::int as unassessed_count
  from grant_deep_analysis_axis_results
  group by run_id
),
latest_audit as (
  select run.current_grant_id as grant_id, audit.*
  from latest_run run
  left join lateral (
    select candidate.*
    from grant_deep_analysis_audits candidate
    where candidate.run_id = run.id
    order by candidate.attempt desc, candidate.completed_at desc, candidate.id desc
    limit 1
  ) audit on true
),
latest_promotion as (
  select active.id as grant_id, item.status as publication_status
  from active_grants active
  left join lateral (
    select candidate.status
    from analysis_lab_promotion_items candidate
    join analysis_lab_promotion_releases release
      on release.id = candidate.release_db_id
    where candidate.grant_id = active.id
    order by candidate.updated_at desc, candidate.id desc
    limit 1
  ) item on true
),
current_projection as (
  select
    active.id as grant_id,
    active.source::text as source,
    active.source_id,
    active.title,
    active.agency,
    active.url,
    active.apply_end,
    active.d_day,
    active.updated_at as grant_updated_at,
    raw.collected_at,
    job.id as job_id,
    job.status as job_status,
    job.attempt_count,
    job.source_revision_sha256 as job_source_revision_sha256,
    job.updated_at as job_updated_at,
    run.id as run_id,
    run.run_id as run_public_id,
    run.status as run_status,
    run.source_revision_sha256 as run_source_revision_sha256,
    run.attachment_manifest_sha256,
    run.input_sha256,
    run.input_artifact_key,
    run.output_artifact_key,
    run.raw_response_artifact_key,
    run.model,
    run.prompt_version,
    run.input_chars,
    run.cost_usd,
    run.error_code,
    run.error_message,
    coalesce(flags.analysis_complete, false) as analysis_complete,
    coalesce(flags.publication_complete, false) as publication_complete,
    coalesce(flags.serving_complete, false) as serving_complete,
    coalesce(flags.analysis_fresh, false) as analysis_fresh,
    coalesce(flags.receipt_failed_or_blocked, false) as receipt_failed_or_blocked,
    coalesce(flags.receipt_stale, false) as receipt_stale,
    coalesce(attachments.attachment_count, 0)::int as attachment_count,
    coalesce(attachments.archived_count, 0)::int as archived_count,
    coalesce(attachments.converted_count, 0)::int as converted_count,
    coalesce(attachments.blocked_attachment_count, 0)::int as blocked_attachment_count,
    coalesce(axes.condition_found_count, 0)::int as condition_found_count,
    coalesce(axes.inspected_no_condition_count, 0)::int as inspected_no_condition_count,
    coalesce(axes.ambiguous_count, 0)::int as ambiguous_count,
    coalesce(axes.input_missing_count, 0)::int as input_missing_count,
    coalesce(axes.unassessed_count, 0)::int as unassessed_count,
    audit.verdict as audit_verdict,
    promotion.publication_status,
    coalesce((
      job.id is not null
      and (
        active.updated_at > job.updated_at
        or raw.collected_at > job.updated_at
        or attachments.latest_attachment_at > job.updated_at
        or (
          run.id is not null
          and run.source_revision_sha256 <> job.source_revision_sha256
        )
      )
    ), false) as source_changed,
    blocker.stage as receipt_blocking_stage
  from active_grants active
  left join grant_raw raw
    on raw.source = active.source and raw.source_id = active.source_id
  left join latest_job job on job.grant_id = active.id
  left join latest_run run on run.current_grant_id = active.id
  left join receipt_flags flags on flags.run_id = run.id
  left join attachment_stats attachments
    on attachments.source = active.source and attachments.source_id = active.source_id
  left join axis_stats axes on axes.run_id = run.id
  left join latest_audit audit on audit.grant_id = active.id
  left join latest_promotion promotion on promotion.grant_id = active.id
  left join lateral (
    select expected.stage
    from unnest(array[
      'source_fresh', 'attachment_inventory_complete', 'attachment_archive_complete',
      'attachment_text_complete', 'input_coverage_verified', 'input_sealed',
      'model_call_passed', 'response_contract_valid', 'axis_coverage_complete',
      'evidence_grounded', 'independent_audit_passed', 'analysis_complete',
      'publication_complete', 'serving_complete', 'analysis_fresh'
    ]::text[]) with ordinality as expected(stage, position)
    left join latest_receipt receipt
      on receipt.run_id = run.id and receipt.stage = expected.stage
    where receipt.status is null
       or receipt.status not in ('passed', 'not_applicable')
    order by expected.position
    limit 1
  ) blocker on true
),
pipeline_base as (
  select
    current.*,
    case
      when current.source_changed
        or current.receipt_stale
        or current.run_status = 'stale'
        then 'stale'
      when current.serving_complete
        and current.analysis_fresh
        and current.run_source_revision_sha256 = current.job_source_revision_sha256
        then 'serving_complete_fresh'
      when current.job_status in ('blocked', 'dead_letter')
        or current.run_status in ('failed', 'blocked')
        or current.receipt_failed_or_blocked
        then 'blocked_or_failed'
      when current.analysis_complete and not current.publication_complete
        then 'analysis_complete_not_published'
      else 'in_progress'
    end as bucket,
    case
      when current.source_changed or current.receipt_stale or current.run_status = 'stale'
        then 'analysis_fresh'
      when current.run_id is null then 'source_fresh'
      else current.receipt_blocking_stage
    end as first_blocking_stage
  from current_projection current
)
`

interface PipelineRow {
  grant_id: string
  source: string
  source_id: string
  title: string
  agency: string | null
  url: string | null
  apply_end: Date | null
  d_day: number | null
  bucket: string
  job_id: string | null
  job_status: string | null
  attempt_count: number | null
  run_id: string | null
  run_public_id: string | null
  run_status: string | null
  first_blocking_stage: string | null
  source_changed: boolean
  attachment_count: number
  archived_count: number
  converted_count: number
  blocked_attachment_count: number
  input_chars: number | null
  model: string | null
  prompt_version: string | null
  cost_usd: string | number | null
  condition_found_count: number
  inspected_no_condition_count: number
  ambiguous_count: number
  input_missing_count: number
  unassessed_count: number
  audit_verdict: string | null
  publication_status: string | null
  job_updated_at: Date | null
  grant_updated_at: Date
}

interface BucketCountRow {
  bucket: string
  count: number
}

interface StageCountRow {
  stage: string
  status: string
  count: number
}

interface ActiveCountRow {
  count: number
}

interface WorkerRow {
  worker_id: string | null
  current_job_id: string | null
  status: string | null
  service_revision: string | null
  metadata: Record<string, unknown>
  heartbeat_at: Date | null
  stale_seconds: number | null
  active_worker_count: number
  active_lease_count: number
  stale_active_worker_count: number
}

interface InputPreparationRow {
  worker_id: string
  status: string
  service_revision: string
  heartbeat_at: Date
  stale_seconds: number
  last_error_code: string | null
  metadata: Record<string, unknown>
}

interface ServingMonitorRow {
  execution_id: string | null
  verified_at: Date | null
  stale_seconds: number | null
  expected_items: number
  checked_items: number
  fresh_items: number
  failed_receipts: number
  stale_receipts: number
}

export interface DeepPipelineQuery {
  bucket: DeepPipelineBucket | null
  stage: DeepAnalysisStageKey | null
  q: string
  limit: number
  grantId?: string
}

export class DeepPipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "DeepPipelineError"
  }
}

export function parseDeepPipelineQuery(params: URLSearchParams): DeepPipelineQuery {
  const bucketValue = params.get("bucket")
  const bucket = isDeepPipelineBucket(bucketValue) ? bucketValue : null
  const stageValue = params.get("stage")
  const stage = isStage(stageValue) ? stageValue : null
  const q = (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH)
  const parsedLimit = Number.parseInt(params.get("limit") ?? String(PAGE_SIZE), 10)
  return {
    bucket,
    stage,
    q,
    limit: Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), PAGE_SIZE) : PAGE_SIZE,
  }
}

export async function getDeepPipelinePageData(
  query: DeepPipelineQuery,
): Promise<{ summary: DeepPipelineSummary; notices: DeepPipelineNoticesResult }> {
  const sql = getAdminSql()
  return sql.begin(async (transaction) => {
    const [summary, notices] = await Promise.all([
      getDeepPipelineSummary(query, transaction),
      getDeepPipelineNotices(query, transaction),
    ])
    return { summary, notices }
  })
}

export function buildServingMonitorSummary(input?: {
  execution_id: string | null
  verified_at: Date | null
  stale_seconds: number | null
  expected_items: number
  checked_items: number
  fresh_items: number
  failed_receipts: number
  stale_receipts: number
}): DeepPipelineSummary["servingMonitor"] {
  const staleSeconds = input?.stale_seconds === null
    || input?.stale_seconds === undefined
    ? null
    : Number(input.stale_seconds)
  const expectedItems = Number(input?.expected_items ?? 0)
  const checkedItems = Number(input?.checked_items ?? 0)
  const freshItems = Number(input?.fresh_items ?? 0)
  const failedReceipts = Number(input?.failed_receipts ?? 0)
  const staleReceipts = Number(input?.stale_receipts ?? 0)
  const stale = staleSeconds === null
    || staleSeconds > DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS

  return {
    executionId: input?.execution_id ?? null,
    verifiedAt: input?.verified_at?.toISOString() ?? null,
    stale,
    staleSeconds,
    expectedItems,
    checkedItems,
    freshItems,
    failedReceipts,
    staleReceipts,
    healthy: !stale
      && expectedItems > 0
      && checkedItems === expectedItems
      && freshItems === expectedItems
      && failedReceipts === 0
      && staleReceipts === 0,
  }
}

export function buildInputPreparationSummary(
  input?: InputPreparationRow,
): DeepPipelineSummary["inputPreparation"] {
  const staleSeconds = input ? Number(input.stale_seconds) : null
  const metadata = input?.metadata ?? {}
  const targetCount = numberMetadata(metadata, "targetCount")
  const sealedCount = numberMetadata(metadata, "sealedCount")
  const unresolvedCount = numberMetadata(metadata, "unresolvedCount")
  const archiveFailedCount = numberMetadata(metadata, "archiveFailedCount")
  const conversionFailedCount = numberMetadata(metadata, "conversionFailedCount")
  const conversionStillPending = numberMetadata(metadata, "conversionStillPending")
  const conversionCandidateAttachmentCount = numberMetadata(
    metadata,
    "conversionCandidateAttachmentCount",
  )
  const conversionSurfacesUpserted = numberMetadata(metadata, "conversionSurfacesUpserted")
  const conversionJobsEnqueued = numberMetadata(metadata, "conversionJobsEnqueued")
  const conversionCacheHits = numberMetadata(metadata, "conversionCacheHits")
  const conversionRegistrationSkipped = numberMetadata(
    metadata,
    "conversionRegistrationSkipped",
  )
  const conversionRegistrationWarnings = numberMetadata(
    metadata,
    "conversionRegistrationWarnings",
  )
  const budgetExhausted = metadata.budgetExhausted === true
  const stale = staleSeconds === null
    || staleSeconds > DEEP_ANALYSIS_INPUT_PREPARATION_STALE_SECONDS
  const statusHealthy = input?.status === "idle" || input?.status === "running"
  return {
    executionId: input?.worker_id ?? null,
    status: input?.status ?? null,
    serviceRevision: input?.service_revision ?? null,
    heartbeatAt: input?.heartbeat_at?.toISOString() ?? null,
    stale,
    staleSeconds,
    targetCount,
    sealedCount,
    unresolvedCount,
    archiveFailedCount,
    conversionFailedCount,
    conversionStillPending,
    conversionCandidateAttachmentCount,
    conversionSurfacesUpserted,
    conversionJobsEnqueued,
    conversionCacheHits,
    conversionRegistrationSkipped,
    conversionRegistrationWarnings,
    budgetExhausted,
    healthy: !stale
      && statusHealthy
      && input?.last_error_code === null
      && archiveFailedCount === 0
      && conversionFailedCount === 0
      && conversionRegistrationWarnings === 0
      && !budgetExhausted,
  }
}

export function buildWorkerSummary(
  input?: WorkerRow,
): DeepPipelineSummary["worker"] {
  const staleSeconds = input?.stale_seconds === null || input?.stale_seconds === undefined
    ? null
    : Number(input.stale_seconds)
  const activeWorkerCount = Number(input?.active_worker_count ?? 0)
  const activeLeaseCount = Number(input?.active_lease_count ?? 0)
  const staleActiveWorkerCount = Number(input?.stale_active_worker_count ?? 0)
  const stale = staleSeconds === null
    || staleSeconds > DEEP_ANALYSIS_DEFAULT_LIMITS.heartbeatStaleSeconds
  const statusHealthy = input?.status === "idle" || input?.status === "running"
  const executionMode = input
    ? input.metadata.executionMode === "observe_only" ? "observe_only" : "active"
    : null
  const claimScope = input
    && (
      input.metadata.claimScope === "unconfigured"
      || input.metadata.claimScope === "bounded"
      || input.metadata.claimScope === "all"
    )
    ? input.metadata.claimScope
    : null
  const claimCohortCount = numberMetadata(input?.metadata ?? {}, "claimCohortCount")
  const claimCohortSha256 = typeof input?.metadata.claimCohortSha256 === "string"
    ? input.metadata.claimCohortSha256
    : null
  const claimScopeHealthy = executionMode !== "active"
    || claimScope === "all"
    || (
      claimScope === "bounded"
      && claimCohortCount > 0
      && Boolean(claimCohortSha256?.match(/^[0-9a-f]{64}$/))
    )
  return {
    workerId: input?.worker_id ?? null,
    currentJobId: input?.current_job_id ?? null,
    status: input?.status ?? null,
    executionMode,
    claimScope,
    claimCohortCount,
    claimCohortSha256,
    serviceRevision: input?.service_revision ?? null,
    heartbeatAt: input?.heartbeat_at?.toISOString() ?? null,
    stale,
    staleSeconds,
    activeWorkerCount,
    activeLeaseCount,
    staleActiveWorkerCount,
    healthy: !stale
      && statusHealthy
      && activeWorkerCount === activeLeaseCount
      && activeWorkerCount <= DEEP_ANALYSIS_DEFAULT_LIMITS.maxConcurrentJobs
      && staleActiveWorkerCount === 0
      && claimScopeHealthy,
  }
}

export async function getDeepPipelineSummary(
  _query: DeepPipelineQuery = { bucket: null, stage: null, q: "", limit: PAGE_SIZE },
  sql: PipelineSql = getAdminSql(),
): Promise<DeepPipelineSummary> {
  const [
    bucketRows,
    stageRows,
    activeRows,
    workerRows,
    inputPreparationRows,
    servingMonitorRows,
  ] = await Promise.all([
    sql.unsafe<BucketCountRow[]>(
      `${DEEP_PIPELINE_BASE_CTE}
       select bucket, count(*)::int as count
       from pipeline_base
       group by bucket`,
      [DEEP_ANALYSIS_MODEL_POLICY_VERSION],
    ),
    sql.unsafe<StageCountRow[]>(
      `${DEEP_PIPELINE_BASE_CTE}
       select receipt.stage, receipt.status, count(*)::int as count
       from pipeline_base base
       join latest_receipt receipt on receipt.run_id = base.run_id
       group by receipt.stage, receipt.status`,
      [DEEP_ANALYSIS_MODEL_POLICY_VERSION],
    ),
    sql.unsafe<ActiveCountRow[]>(
      `${DEEP_PIPELINE_BASE_CTE}
       select count(*)::int as count from pipeline_base`,
      [DEEP_ANALYSIS_MODEL_POLICY_VERSION],
    ),
    sql.unsafe<WorkerRow[]>(
      `with workers as (
         select
           heartbeat.worker_id,
           heartbeat.current_job_id,
           heartbeat.status,
           heartbeat.service_revision,
           heartbeat.metadata,
           heartbeat.heartbeat_at,
           extract(epoch from (now() - heartbeat.heartbeat_at))::int as stale_seconds
         from grant_deep_analysis_worker_heartbeats heartbeat
         where heartbeat.model_policy_version = $1
           and heartbeat.worker_id not like 'cunote-deep-analysis-input-preparation-%'
       ),
       active_leases as (
         select job.id, job.worker_id
         from grant_deep_analysis_jobs job
         where job.model_policy_version = $1
           and job.status = 'leased'
           and job.lease_expires_at > now()
       ),
       active_workers as (
         select worker.*
         from active_leases lease
         join workers worker
           on worker.current_job_id = lease.id
          and worker.worker_id = lease.worker_id
          and worker.status = 'running'
       ),
       selected as (
         select ranked.*
         from (
           select worker.*, 0 as selection_priority
           from active_workers worker
           union all
           select worker.*, 1 as selection_priority
           from workers worker
         ) ranked
         order by ranked.selection_priority, ranked.heartbeat_at desc
         limit 1
       ),
       counts as (
         select
           (select count(*)::int from active_workers) as active_worker_count,
           (select count(*)::int from active_leases) as active_lease_count,
           (
             select count(*)::int
             from active_workers
             where stale_seconds > $2
           ) as stale_active_worker_count
       )
       select
         selected.worker_id,
         selected.current_job_id,
         selected.status,
         selected.service_revision,
         selected.metadata,
         selected.heartbeat_at,
         selected.stale_seconds,
         counts.active_worker_count,
         counts.active_lease_count,
         counts.stale_active_worker_count
       from counts
       left join selected on true`,
      [
        DEEP_ANALYSIS_MODEL_POLICY_VERSION,
        DEEP_ANALYSIS_DEFAULT_LIMITS.heartbeatStaleSeconds,
      ],
    ),
    sql.unsafe<InputPreparationRow[]>(
      `select
         worker_id,
         status,
         service_revision,
         last_error_code,
         metadata,
         heartbeat_at,
         extract(epoch from (now() - heartbeat_at))::int as stale_seconds
       from grant_deep_analysis_worker_heartbeats
       where model_policy_version = $1
         and worker_id like 'cunote-deep-analysis-input-preparation-%'
       order by heartbeat_at desc
       limit 1`,
      [DEEP_ANALYSIS_MODEL_POLICY_VERSION],
    ),
    sql.unsafe<ServingMonitorRow[]>(
      `with expected as (
         select count(*)::int as expected_items
         from analysis_lab_promotion_items item
         join analysis_lab_promotion_releases release
           on release.id = item.release_db_id
         where release.status = 'active'
           and item.status = 'applied'
           and item.deep_analysis_run_id is not null
       ),
       latest_monitor as (
         select
           receipt.evidence->>'monitorExecutionId' as execution_id,
           max(receipt.created_at) as verified_at
         from grant_deep_analysis_stage_receipts receipt
         where receipt.stage = 'publication_complete'
           and receipt.verifier_version = $1
           and receipt.evidence->>'observationMode' = 'active_monitor'
           and receipt.evidence->>'monitorRuntime' = 'cloud_run'
           and coalesce(receipt.evidence->>'monitorExecutionId', '') <> ''
         group by receipt.evidence->>'monitorExecutionId'
         order by verified_at desc
         limit 1
       ),
       observed as (
         select
           count(distinct receipt.evidence->>'promotionItemId')::int as checked_items,
           count(distinct receipt.evidence->>'promotionItemId') filter (
             where receipt.stage = 'analysis_fresh' and receipt.status = 'passed'
           )::int as fresh_items,
           count(*) filter (where receipt.status = 'failed')::int as failed_receipts,
           count(*) filter (where receipt.status = 'stale')::int as stale_receipts
         from latest_monitor monitor
         join grant_deep_analysis_stage_receipts receipt
           on receipt.evidence->>'monitorExecutionId' = monitor.execution_id
          and receipt.verifier_version = $1
          and receipt.evidence->>'observationMode' = 'active_monitor'
          and receipt.evidence->>'monitorRuntime' = 'cloud_run'
          and receipt.stage in (
            'publication_complete', 'serving_complete', 'analysis_fresh'
          )
       )
       select
         monitor.execution_id,
         monitor.verified_at,
         extract(epoch from (now() - monitor.verified_at))::int as stale_seconds,
         expected.expected_items,
         coalesce(observed.checked_items, 0)::int as checked_items,
         coalesce(observed.fresh_items, 0)::int as fresh_items,
         coalesce(observed.failed_receipts, 0)::int as failed_receipts,
         coalesce(observed.stale_receipts, 0)::int as stale_receipts
       from expected
       left join latest_monitor monitor on true
       left join observed on true`,
      [DEEP_ANALYSIS_SERVING_VERIFIER_VERSION],
    ),
  ])

  const activeTotal = Number(activeRows[0]?.count ?? 0)
  const bucketCounts = new Map(
    bucketRows.map((row) => [row.bucket, Number(row.count)]),
  )
  const buckets = DEEP_PIPELINE_BUCKETS.map((key) => ({
    key,
    label: DEEP_PIPELINE_BUCKET_LABELS[key],
    count: bucketCounts.get(key) ?? 0,
  }))
  const classifiedTotal = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  const stageCounts = new Map(
    stageRows.map((row) => [`${row.stage}:${row.status}`, Number(row.count)]),
  )
  return {
    generatedAt: new Date().toISOString(),
    activeTotal,
    classifiedTotal,
    degraded: activeTotal !== classifiedTotal,
    buckets,
    stages: DEEP_ANALYSIS_STAGE_KEYS.map((stage) => {
      const counts = {
        passed: stageCounts.get(`${stage}:passed`) ?? 0,
        failed: stageCounts.get(`${stage}:failed`) ?? 0,
        blocked: stageCounts.get(`${stage}:blocked`) ?? 0,
        stale: stageCounts.get(`${stage}:stale`) ?? 0,
        running: stageCounts.get(`${stage}:running`) ?? 0,
        pending: stageCounts.get(`${stage}:pending`) ?? 0,
        notApplicable: stageCounts.get(`${stage}:not_applicable`) ?? 0,
      }
      const observed = Object.values(counts).reduce((sum, value) => sum + value, 0)
      return {
        stage,
        label: DEEP_STAGE_LABELS[stage],
        ...counts,
        missing: Math.max(0, activeTotal - observed),
      }
    }),
    worker: buildWorkerSummary(workerRows[0]),
    inputPreparation: buildInputPreparationSummary(inputPreparationRows[0]),
    servingMonitor: buildServingMonitorSummary(servingMonitorRows[0]),
  }
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export async function getDeepPipelineNotices(
  query: DeepPipelineQuery,
  sql: PipelineSql = getAdminSql(),
): Promise<DeepPipelineNoticesResult> {
  const rows = await sql.unsafe<PipelineRow[]>(
    `${DEEP_PIPELINE_BASE_CTE}
     select *
     from pipeline_base
     where ($2::text is null or bucket = $2)
       and (
         $3::text = ''
         or title ilike '%' || $3 || '%'
         or source_id ilike '%' || $3 || '%'
         or coalesce(agency, '') ilike '%' || $3 || '%'
       )
       and ($4::uuid is null or grant_id = $4)
       and ($5::text is null or first_blocking_stage = $5)
     order by
       case bucket
         when 'blocked_or_failed' then 0
         when 'stale' then 1
         when 'analysis_complete_not_published' then 2
         when 'in_progress' then 3
         else 4
       end,
       d_day asc nulls last,
       grant_id
     limit $6`,
    [
      DEEP_ANALYSIS_MODEL_POLICY_VERSION,
      query.bucket,
      query.q,
      query.grantId ?? null,
      query.stage,
      query.limit,
    ],
  )
  const countRows = await sql.unsafe<ActiveCountRow[]>(
    `${DEEP_PIPELINE_BASE_CTE}
     select count(*)::int as count
     from pipeline_base
     where ($2::text is null or bucket = $2)
       and (
         $3::text = ''
         or title ilike '%' || $3 || '%'
         or source_id ilike '%' || $3 || '%'
         or coalesce(agency, '') ilike '%' || $3 || '%'
       )
       and ($4::uuid is null or grant_id = $4)
       and ($5::text is null or first_blocking_stage = $5)`,
    [
      DEEP_ANALYSIS_MODEL_POLICY_VERSION,
      query.bucket,
      query.q,
      query.grantId ?? null,
      query.stage,
    ],
  )
  return {
    generatedAt: new Date().toISOString(),
    total: Number(countRows[0]?.count ?? 0),
    items: rows.map(mapNotice),
  }
}

export async function getDeepPipelineNoticeDetail(
  grantId: string,
  sql: PipelineSql = getAdminSql(),
): Promise<DeepPipelineNoticeDetail> {
  assertUuid(grantId, "grantId")
  const noticeResult = await getDeepPipelineNotices({
    bucket: null,
    stage: null,
    q: "",
    limit: 1,
    grantId,
  }, sql)
  const notice = noticeResult.items[0]
  if (!notice) {
    throw new DeepPipelineError(
      "deep_pipeline_notice_not_found",
      "활성 딥분석 대상 공고를 찾을 수 없습니다.",
      404,
    )
  }

  const [
    runRows,
    receiptRows,
    axisRows,
    auditRows,
    exceptionRows,
    attachmentRows,
    promotionRows,
    actionRows,
    aggregateSplitRows,
  ] = await Promise.all([
    sql.unsafe<RunDetailRow[]>(
      `select *
       from grant_deep_analysis_runs
       where id = $1::uuid`,
      [notice.runId],
    ),
    notice.runId ? sql.unsafe<ReceiptRow[]>(
      `select distinct on (stage) *
       from grant_deep_analysis_stage_receipts
       where run_id = $1::uuid
       order by stage, attempt desc, created_at desc`,
      [notice.runId],
    ) : Promise.resolve([]),
    notice.runId ? sql.unsafe<AxisRow[]>(
      `select *
       from grant_deep_analysis_axis_results
       where run_id = $1::uuid
       order by dimension`,
      [notice.runId],
    ) : Promise.resolve([]),
    notice.runId ? sql.unsafe<AuditRow[]>(
      `select *
       from grant_deep_analysis_audits
       where run_id = $1::uuid
       order by attempt desc, completed_at desc`,
      [notice.runId],
    ) : Promise.resolve([]),
    notice.runId ? sql.unsafe<ExceptionRow[]>(
      `select
         event.*,
         event.id = (
           select latest.id
           from grant_deep_analysis_exception_events latest
           where latest.run_id = event.run_id
             and latest.exception_key = event.exception_key
           order by latest.created_at desc, latest.id desc
           limit 1
         ) as current
       from grant_deep_analysis_exception_events event
       where event.run_id = $1::uuid
       order by event.created_at desc, event.id desc`,
      [notice.runId],
    ) : Promise.resolve([]),
    sql.unsafe<AttachmentRow[]>(
      `select *
       from grant_attachment_archives
       where source = $1 and source_id = $2
       order by filename, id`,
      [notice.source, notice.sourceId],
    ),
    sql.unsafe<PromotionRow[]>(
      `select
         item.id as item_id,
         release.release_id,
         release.status as release_status,
         item.status as item_status,
         item.plan_sha256,
         item.before_sha256,
         item.after_sha256,
         item.applied_at,
         item.updated_at
       from analysis_lab_promotion_items item
       join analysis_lab_promotion_releases release
         on release.id = item.release_db_id
       where item.grant_id = $1::uuid
       order by item.updated_at desc, item.id desc`,
      [grantId],
    ),
    sql.unsafe<ActionRow[]>(
      `select action.*, actor.email as actor_email
       from admin_deep_analysis_actions action
       join admin_users actor on actor.id = action.admin_user_id
       where action.grant_id = $1::uuid
       order by action.created_at desc, action.id desc`,
      [grantId],
    ),
    sql.unsafe<AggregateSplitCaseRow[]>(
      `select split_case.*, approver.email as approved_by_email
       from grant_aggregate_split_cases split_case
       left join admin_users approver
         on approver.id = split_case.approved_by_admin_user_id
       where split_case.grant_id = $1::uuid
       order by split_case.created_at desc, split_case.id desc
       limit 1`,
      [grantId],
    ),
  ])

  const run = runRows[0]
  return {
    notice,
    sourceRevisionSha256: run?.source_revision_sha256 ?? null,
    attachmentManifestSha256: run?.attachment_manifest_sha256 ?? null,
    inputSha256: run?.input_sha256 ?? null,
    inputArtifactKey: run?.input_artifact_key ?? null,
    outputArtifactKey: run?.output_artifact_key ?? null,
    rawResponseArtifactKey: run?.raw_response_artifact_key ?? null,
    errorCode: run?.error_code ?? null,
    errorMessage: run?.error_message ?? null,
    receipts: receiptRows.map(mapReceipt),
    axes: axisRows.map(mapAxis),
    audits: auditRows.map(mapAudit),
    exceptions: exceptionRows.map(mapException),
    attachments: attachmentRows.map(mapAttachment),
    promotions: promotionRows.map(mapPromotion),
    adminActions: actionRows.map(mapAdminAction),
    aggregateSplitCase: aggregateSplitRows[0]
      ? mapAggregateSplitCase(aggregateSplitRows[0])
      : null,
  }
}

interface RunDetailRow {
  source_revision_sha256: string
  attachment_manifest_sha256: string
  input_sha256: string
  input_artifact_key: string
  output_artifact_key: string | null
  raw_response_artifact_key: string | null
  error_code: string | null
  error_message: string | null
}

interface ReceiptRow {
  id: string
  stage: string
  status: string
  verifier_version: string
  evidence: Record<string, unknown>
  evidence_sha256: string
  artifact_key: string | null
  attempt: number
  created_at: Date
}

interface AxisRow {
  dimension: CriterionDimension
  status: DeepAnalysisAxisStatus
  confidence: number
  comment: string | null
  evidence_refs: Array<Record<string, unknown>>
  criterion_semantic_hashes: string[]
}

interface AuditRow {
  id: string
  attempt: number
  model: string
  prompt_version: string
  verdict: string
  item_results: Array<Record<string, unknown>>
  artifact_key: string
  artifact_sha256: string
  started_at: Date
  completed_at: Date
}

interface ExceptionRow {
  id: string
  exception_key: string
  event_type: string
  reason_code: string
  actor_type: string
  actor: string
  detail: Record<string, unknown>
  evidence_sha256: string
  created_at: Date
  current: boolean
}

interface AttachmentRow {
  id: string
  filename: string
  source_uri: string
  content_type: string | null
  bytes: number | null
  sha256: string | null
  storage_key: string | null
  conversion_status: string | null
  markdown_storage_key: string | null
  markdown_sha256: string | null
  converter: string | null
  conversion_error: string | null
  updated_at: Date
}

interface PromotionRow {
  item_id: string
  release_id: string
  release_status: string
  item_status: string
  plan_sha256: string
  before_sha256: string
  after_sha256: string | null
  applied_at: Date | null
  updated_at: Date
}

interface ActionRow {
  id: string
  request_id: string
  actor_email: string
  action: DeepPipelineAdminAction["action"]
  outcome: "succeeded" | "failed"
  exception_key: string | null
  detail: Record<string, unknown>
  error: string | null
  created_at: Date
}

interface AggregateSplitCaseRow {
  id: string
  status: DeepPipelineAggregateSplitCase["status"]
  reason_code: DeepPipelineAggregateSplitCase["reasonCode"]
  source_revision_sha256: string
  input_chars: number
  input_cap_chars: number
  cost_cap_usd: number
  chunk_count: number
  attachment_count: number
  evidence_sha256: string
  approved_by_email: string | null
  approved_at: Date | null
  attempt_count: number
  max_attempts: number
  available_at: Date
  leased_at: Date | null
  lease_expires_at: Date | null
  worker_id: string | null
  processing_started_at: Date | null
  completed_at: Date | null
  model: string | null
  prompt_version: string | null
  input_artifact_key: string | null
  input_sha256: string | null
  manifest_artifact_key: string | null
  manifest_sha256: string | null
  raw_response_artifact_key: string | null
  raw_response_sha256: string | null
  segment_count: number | null
  program_count: number | null
  external_calls_made: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: Date
  updated_at: Date
}

function mapNotice(row: PipelineRow): DeepPipelineNoticeItem {
  if (!isDeepPipelineBucket(row.bucket)) {
    throw new DeepPipelineError(
      "deep_pipeline_bucket_invalid",
      `알 수 없는 딥분석 버킷입니다: ${row.bucket}`,
      500,
    )
  }
  return {
    grantId: row.grant_id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    agency: row.agency,
    url: row.url,
    applyEnd: row.apply_end?.toISOString() ?? null,
    dDay: row.d_day,
    bucket: row.bucket,
    jobId: row.job_id,
    jobStatus: row.job_status,
    runId: row.run_id,
    runPublicId: row.run_public_id,
    runStatus: row.run_status,
    firstBlockingStage: isStage(row.first_blocking_stage) ? row.first_blocking_stage : null,
    sourceChanged: row.source_changed,
    attachmentCount: Number(row.attachment_count),
    archivedCount: Number(row.archived_count),
    convertedCount: Number(row.converted_count),
    blockedAttachmentCount: Number(row.blocked_attachment_count),
    inputChars: row.input_chars === null ? null : Number(row.input_chars),
    model: row.model,
    promptVersion: row.prompt_version,
    attemptCount: row.attempt_count === null ? null : Number(row.attempt_count),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    axisCounts: {
      condition_found: Number(row.condition_found_count),
      inspected_no_condition: Number(row.inspected_no_condition_count),
      ambiguous: Number(row.ambiguous_count),
      input_missing: Number(row.input_missing_count),
      unassessed: Number(row.unassessed_count),
    },
    auditVerdict: row.audit_verdict,
    publicationStatus: row.publication_status,
    updatedAt: (row.job_updated_at ?? row.grant_updated_at).toISOString(),
  }
}

function mapReceipt(row: ReceiptRow): DeepPipelineStageReceipt {
  if (!isStage(row.stage) || !isStageStatus(row.status)) {
    throw new DeepPipelineError(
      "deep_pipeline_receipt_invalid",
      `알 수 없는 stage receipt입니다: ${row.stage}/${row.status}`,
      500,
    )
  }
  return {
    id: row.id,
    stage: row.stage,
    label: DEEP_STAGE_LABELS[row.stage],
    status: row.status,
    verifierVersion: row.verifier_version,
    evidence: row.evidence,
    evidenceSha256: row.evidence_sha256,
    artifactKey: row.artifact_key,
    attempt: Number(row.attempt),
    createdAt: row.created_at.toISOString(),
  }
}

function mapAxis(row: AxisRow): DeepPipelineAxis {
  return {
    dimension: row.dimension,
    label: AXIS_LABELS[row.dimension],
    status: row.status,
    confidence: Number(row.confidence),
    comment: row.comment,
    evidenceRefs: row.evidence_refs,
    criterionSemanticHashes: row.criterion_semantic_hashes,
  }
}

function mapAudit(row: AuditRow): DeepPipelineAudit {
  return {
    id: row.id,
    attempt: Number(row.attempt),
    model: row.model,
    promptVersion: row.prompt_version,
    verdict: row.verdict,
    itemResults: row.item_results,
    artifactKey: row.artifact_key,
    artifactSha256: row.artifact_sha256,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
  }
}

function mapException(row: ExceptionRow): DeepPipelineException {
  return {
    id: row.id,
    exceptionKey: row.exception_key,
    eventType: row.event_type,
    reasonCode: row.reason_code,
    actorType: row.actor_type,
    actor: row.actor,
    detail: row.detail,
    evidenceSha256: row.evidence_sha256,
    createdAt: row.created_at.toISOString(),
    current: row.current,
  }
}

function mapAttachment(row: AttachmentRow): DeepPipelineAttachment {
  return {
    id: row.id,
    filename: row.filename,
    sourceUri: row.source_uri,
    contentType: row.content_type,
    bytes: row.bytes,
    sha256: row.sha256,
    storageKey: row.storage_key,
    conversionStatus: row.conversion_status,
    markdownStorageKey: row.markdown_storage_key,
    markdownSha256: row.markdown_sha256,
    converter: row.converter,
    conversionError: row.conversion_error,
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapPromotion(row: PromotionRow): DeepPipelinePromotion {
  return {
    itemId: row.item_id,
    releaseId: row.release_id,
    releaseStatus: row.release_status,
    itemStatus: row.item_status,
    planSha256: row.plan_sha256,
    beforeSha256: row.before_sha256,
    afterSha256: row.after_sha256,
    appliedAt: row.applied_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapAdminAction(row: ActionRow): DeepPipelineAdminAction {
  return {
    id: row.id,
    requestId: row.request_id,
    actorEmail: row.actor_email,
    action: row.action,
    outcome: row.outcome,
    exceptionKey: row.exception_key,
    detail: row.detail,
    error: row.error,
    createdAt: row.created_at.toISOString(),
  }
}

function mapAggregateSplitCase(
  row: AggregateSplitCaseRow,
): DeepPipelineAggregateSplitCase {
  return {
    id: row.id,
    status: row.status,
    reasonCode: row.reason_code,
    sourceRevisionSha256: row.source_revision_sha256,
    inputChars: Number(row.input_chars),
    inputCapChars: Number(row.input_cap_chars),
    costCapUsd: Number(row.cost_cap_usd),
    chunkCount: Number(row.chunk_count),
    attachmentCount: Number(row.attachment_count),
    evidenceSha256: row.evidence_sha256,
    approvedByEmail: row.approved_by_email,
    approvedAt: row.approved_at?.toISOString() ?? null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at.toISOString(),
    leasedAt: row.leased_at?.toISOString() ?? null,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    workerId: row.worker_id,
    processingStartedAt: row.processing_started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    model: row.model,
    promptVersion: row.prompt_version,
    inputArtifactKey: row.input_artifact_key,
    inputSha256: row.input_sha256,
    manifestArtifactKey: row.manifest_artifact_key,
    manifestSha256: row.manifest_sha256,
    rawResponseArtifactKey: row.raw_response_artifact_key,
    rawResponseSha256: row.raw_response_sha256,
    segmentCount: row.segment_count === null ? null : Number(row.segment_count),
    programCount: row.program_count === null ? null : Number(row.program_count),
    externalCallsMade: row.external_calls_made === null
      ? null
      : Number(row.external_calls_made),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function isStage(value: unknown): value is DeepAnalysisStageKey {
  return typeof value === "string"
    && DEEP_ANALYSIS_STAGE_KEYS.includes(value as DeepAnalysisStageKey)
}

function isStageStatus(value: unknown): value is DeepAnalysisStageStatus {
  return typeof value === "string"
    && [
      "pending",
      "running",
      "passed",
      "failed",
      "blocked",
      "stale",
      "not_applicable",
    ].includes(value)
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DeepPipelineError(
      "deep_pipeline_invalid_identifier",
      `${field} 형식이 올바르지 않습니다.`,
      400,
    )
  }
}
