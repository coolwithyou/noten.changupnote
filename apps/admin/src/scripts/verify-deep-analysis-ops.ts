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
        to_regclass('admin_deep_analysis_actions') is not null as action_table_exists
    `
    return { summary, bucketCounts, catalog }
  })

  const failures: string[] = []
  const catalog = report.catalog ?? {
    active_function: false,
    action_table_rls: false,
    action_append_only_trigger: false,
    action_table_exists: false,
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

  const output = {
    schema: "deep-analysis-ops-verification-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    activeTotal: report.summary.activeTotal,
    classifiedTotal: report.summary.classifiedTotal,
    buckets: report.bucketCounts,
    worker: report.summary.worker,
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
