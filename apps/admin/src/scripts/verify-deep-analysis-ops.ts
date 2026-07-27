import {
  DEEP_PIPELINE_BUCKETS,
} from "@/features/pipeline/contract"
import {
  getDeepPipelineNotices,
  getDeepPipelineSummary,
} from "@/lib/server/admin/deepPipeline"
import {
  closeAdminSql,
  getAdminSql,
} from "@/lib/server/db/client"

async function main() {
  const sql = getAdminSql()
  const report = await sql.begin(async (transaction) => {
    const summary = await getDeepPipelineSummary(
      { bucket: null, stage: null, q: "", limit: 100 },
      transaction,
    )
    const bucketCounts: Record<string, number> = {}
    for (const bucket of DEEP_PIPELINE_BUCKETS) {
      const notices = await getDeepPipelineNotices(
        { bucket, stage: null, q: "", limit: 1 },
        transaction,
      )
      bucketCounts[bucket] = notices.total
    }
    const [catalog] = await transaction<{
      active_function: boolean
      action_table_rls: boolean
      action_append_only_trigger: boolean
      action_table_exists: boolean
      aggregate_split_promotion_columns: boolean
      aggregate_split_exposure_columns: boolean
      aggregate_split_child_job_fk: boolean
      aggregate_split_child_rls: boolean
    }[]>`
      select
        to_regprocedure('cunote_active_deep_analysis_grants(timestamptz)') is not null
          as active_function,
        coalesce((
          select relrowsecurity
          from pg_class
          where oid = to_regclass('admin_deep_analysis_actions')
        ), false) as action_table_rls,
        exists (
          select 1
          from pg_trigger
          where tgrelid = to_regclass('admin_deep_analysis_actions')
            and tgname = 'admin_deep_analysis_actions_append_only'
            and not tgisinternal
        ) as action_append_only_trigger,
        to_regclass('admin_deep_analysis_actions') is not null as action_table_exists,
        (
          select count(*) = 8
          from pg_attribute
          where attrelid = to_regclass('grant_aggregate_split_cases')
            and attname in (
              'promotion_status',
              'staged_child_count',
              'enqueued_child_count',
              'children_staged_at',
              'children_enqueued_at',
              'active_feeder_bypass_reason',
              'promotion_last_error_code',
              'promotion_last_error_message'
            )
            and not attisdropped
        ) as aggregate_split_promotion_columns,
        (
          select count(*) = 9
          from pg_attribute
          where attrelid = to_regclass('grant_aggregate_split_cases')
            and attname in (
              'exposure_status',
              'exposure_release_id',
              'exposed_child_count',
              'children_visible_at',
              'serving_verified_at',
              'visibility_rolled_back_at',
              'exposure_actor',
              'exposure_last_error_code',
              'exposure_last_error_message'
            )
            and not attisdropped
        ) as aggregate_split_exposure_columns,
        exists (
          select 1
          from pg_constraint
          where conrelid = to_regclass('grant_aggregate_split_children')
            and conname =
              'grant_aggregate_split_children_deep_analysis_job_id_grant_deep_analysis_jobs_id_fk'
            and contype = 'f'
        ) as aggregate_split_child_job_fk,
        coalesce((
          select relrowsecurity
          from pg_class
          where oid = to_regclass('grant_aggregate_split_children')
        ), false) as aggregate_split_child_rls
    `
    return { summary, bucketCounts, catalog }
  })

  const failures: string[] = []
  const catalog = report.catalog ?? {
    active_function: false,
    action_table_rls: false,
    action_append_only_trigger: false,
    action_table_exists: false,
    aggregate_split_promotion_columns: false,
    aggregate_split_exposure_columns: false,
    aggregate_split_child_job_fk: false,
    aggregate_split_child_rls: false,
  }
  if (report.summary.activeTotal !== report.summary.classifiedTotal) {
    failures.push(
      `bucket conservation failed: active=${report.summary.activeTotal}, classified=${report.summary.classifiedTotal}`,
    )
  }
  for (const bucket of report.summary.buckets) {
    if (bucket.count !== report.bucketCounts[bucket.key]) {
      failures.push(
        `bucket count mismatch ${bucket.key}: summary=${bucket.count}, notices=${report.bucketCounts[bucket.key]}`,
      )
    }
  }
  if (!catalog.active_function) failures.push("shared active predicate function is missing")
  if (!catalog.action_table_exists) failures.push("admin action audit table is missing")
  if (!catalog.action_table_rls) failures.push("admin action audit RLS is disabled")
  if (!catalog.action_append_only_trigger) failures.push("admin action append-only trigger is missing")
  if (!catalog.aggregate_split_promotion_columns) {
    failures.push("aggregate split staged promotion columns are missing")
  }
  if (!catalog.aggregate_split_exposure_columns) {
    failures.push("aggregate split exposure evidence columns are missing")
  }
  if (!catalog.aggregate_split_child_job_fk) {
    failures.push("aggregate split child deep-analysis job FK is missing")
  }
  if (!catalog.aggregate_split_child_rls) {
    failures.push("aggregate split child RLS is disabled")
  }
  if (!report.summary.worker.healthy) {
    failures.push(
      `analysis worker is unhealthy: status=${report.summary.worker.status}, stale=${report.summary.worker.stale}, activeWorkers=${report.summary.worker.activeWorkerCount}, activeLeases=${report.summary.worker.activeLeaseCount}, staleActive=${report.summary.worker.staleActiveWorkerCount}`,
    )
  }
  if (report.summary.servingMonitor.stale) {
    failures.push("serving monitor heartbeat is stale or missing")
  }
  if (!report.summary.servingMonitor.healthy) {
    failures.push(
      `serving monitor is unhealthy: checked=${report.summary.servingMonitor.checkedItems}/${report.summary.servingMonitor.expectedItems}, fresh=${report.summary.servingMonitor.freshItems}, failed=${report.summary.servingMonitor.failedReceipts}, stale=${report.summary.servingMonitor.staleReceipts}`,
    )
  }
  if (report.summary.inputPreparation.stale) {
    failures.push("input preparation heartbeat is stale or missing")
  }
  if (!report.summary.inputPreparation.healthy) {
    failures.push(
      `input preparation is unhealthy: status=${report.summary.inputPreparation.status}, archivedFailed=${report.summary.inputPreparation.archiveFailedCount}, conversionFailed=${report.summary.inputPreparation.conversionFailedCount}, budgetExhausted=${report.summary.inputPreparation.budgetExhausted}`,
    )
  }

  const output = {
    schema: "deep-analysis-ops-verification-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    activeTotal: report.summary.activeTotal,
    classifiedTotal: report.summary.classifiedTotal,
    buckets: report.bucketCounts,
    worker: report.summary.worker,
    inputPreparation: report.summary.inputPreparation,
    servingMonitor: report.summary.servingMonitor,
    stagePassed: Object.fromEntries(
      report.summary.stages.map((stage) => [stage.stage, stage.passed]),
    ),
    catalog,
    failures,
  }
  console.log(JSON.stringify(output, null, 2))
  if (failures.length > 0) process.exitCode = 2
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeAdminSql()
  })
