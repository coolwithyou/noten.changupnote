import type postgres from "postgres"

import {
  CRITERION_DIMENSION_LABELS,
  DEADLINE_BUCKETS,
  MANAGEMENT_STATES,
  PIPELINE_CRITERION_DIMENSIONS,
  PIPELINE_SOURCES,
  PIPELINE_SOURCE_LABELS,
  PIPELINE_STATUSES,
  type DeadlineBucket,
  type ManagementState,
  type PipelineAdminActionDetail,
  type PipelineAttachmentDetail,
  type PipelineBucket,
  type PipelineBucketSummary,
  type PipelineCriterionDetail,
  type PipelineCriterionDot,
  type PipelineHistoryDetail,
  type PipelineAnalysisPairDetail,
  type PipelineLens,
  type PipelineMeasurement,
  type PipelineGoldenSetDetail,
  type PipelineNoticeDetail,
  type PipelineNoticeItem,
  type PipelineNoticesResult,
  type PipelineQueryState,
  type PipelineSort,
  type PipelineSource,
  type PipelineSourceSummary,
  type PipelineStatus,
  type PipelineSummary,
  type PipelineSurfaceDetail,
  isDeadlineBucket,
  isManagementState,
  isPipelineBucket,
  isPipelineLens,
  isPipelineSort,
  isPipelineSource,
  isPipelineStatus,
  labelForPipelineBucket,
} from "@/features/pipeline/contract"
import { getAdminSql } from "@/lib/server/db/client"

const PAGE_SIZE = 50
const REFRESH_AFTER_SECONDS = 60
const MAX_SEARCH_LENGTH = 100
const MAX_PAGE = 10_000

const PIPELINE_DEADLINE_BUCKET_SQL = `
case
  when g.apply_end is null then 'unknown'
  when timezone('Asia/Seoul', g.apply_end)::date
    <= timezone('Asia/Seoul', now())::date then 'today'
  when timezone('Asia/Seoul', g.apply_end)::date
    <= timezone('Asia/Seoul', now())::date + 3 then 'within_3_days'
  when timezone('Asia/Seoul', g.apply_end)::date
    <= timezone('Asia/Seoul', now())::date + 7 then 'within_7_days'
  when timezone('Asia/Seoul', g.apply_end)::date
    <= timezone('Asia/Seoul', now())::date + 30 then 'within_30_days'
  else 'later'
end
`

const PIPELINE_MANAGEMENT_STATE_SQL = `
case
  when g.status = 'closed' then 'closed'
  when gr.status = 'failed'
    or coalesce(ast.attachment_failed_count, 0) > 0
    or coalesce(ss.surface_failed_count, 0) > 0 then 'failed'
  when coalesce(cs.needs_review_count, 0) > 0
    or le.extraction_status = 'review' then 'needs_admin'
  when gr.status in ('fetched', 'converted', 'extracted', 'normalized')
    or gr.status is null then 'in_pipeline'
  when gr.status = 'published'
    and le.extraction_status = 'labeled'
    and coalesce(ast.attachment_unresolved_count, 0) = 0 then 'ok'
  when gr.status = 'published' then 'auto_reviewable'
  else 'in_pipeline'
end
`

const PIPELINE_BASE_CTE = `
with criteria_stats as (
  select
    grant_id,
    count(distinct dimension)::int as criteria_count,
    count(*) filter (where needs_review)::int as needs_review_count,
    jsonb_agg(
      jsonb_build_object(
        'dimension', dimension::text,
        'value', value,
        'needsReview', needs_review
      )
      order by dimension, id
    ) as criteria_summary
  from grant_criteria
  group by grant_id
),
attachment_stats as (
  select
    source,
    source_id,
    count(*)::int as attachment_count,
    count(*) filter (
      where conversion_status = 'failed' or conversion_status is null
    )::int as attachment_problem_count,
    count(*) filter (where conversion_status = 'failed')::int as attachment_failed_count,
    count(*) filter (
      where conversion_status is null
        or conversion_status not in ('converted', 'skipped')
    )::int as attachment_unresolved_count
  from grant_attachment_archives
  group by source, source_id
),
surface_stats as (
  select
    grant_id,
    count(*) filter (where extraction_status = 'failed')::int as surface_failed_count
  from grant_application_surfaces
  group by grant_id
),
latest_extraction as (
  select distinct on (grant_id)
    grant_id,
    status::text as extraction_status,
    ts as extraction_at
  from extraction_log
  where grant_id is not null
  order by grant_id, ts desc, id desc
),
pipeline_base as (
  select
    g.id as grant_id,
    g.source::text as source,
    g.source_id,
    g.title,
    g.url,
    coalesce(g.agency_primary, g.agency_operator, g.agency_jurisdiction) as agency,
    g.apply_start,
    g.apply_end,
    g.status::text as grant_status,
    g.updated_at,
    g.parser_version,
    g.model_ver,
    g.prompt_ver,
    gr.status::text as pipeline_status,
    gr.collected_at,
    coalesce(cs.criteria_count, 0)::int as criteria_count,
    coalesce(cs.needs_review_count, 0)::int as needs_review_count,
    coalesce(cs.criteria_summary, '[]'::jsonb) as criteria_summary,
    coalesce(ast.attachment_count, 0)::int as attachment_count,
    coalesce(ast.attachment_problem_count, 0)::int as attachment_problem_count,
    coalesce(ast.attachment_failed_count, 0)::int as attachment_failed_count,
    coalesce(ast.attachment_unresolved_count, 0)::int as attachment_unresolved_count,
    coalesce(ss.surface_failed_count, 0)::int as surface_failed_count,
    le.extraction_status,
    le.extraction_at,
    case
      when g.apply_end is null then null
      else (
        timezone('Asia/Seoul', g.apply_end)::date
        - timezone('Asia/Seoul', now())::date
      )::int
    end as d_day,
    ${PIPELINE_DEADLINE_BUCKET_SQL} as deadline_bucket,
    ${PIPELINE_MANAGEMENT_STATE_SQL} as management_state
  from grants g
  left join grant_raw gr
    on gr.source = g.source and gr.source_id = g.source_id
  left join criteria_stats cs on cs.grant_id = g.id
  left join attachment_stats ast
    on ast.source = g.source and ast.source_id = g.source_id
  left join surface_stats ss on ss.grant_id = g.id
  left join latest_extraction le on le.grant_id = g.id
)
`

const PIPELINE_SUMMARY_CTE = `
with target_grants as materialized (
  select
    id,
    source,
    source_id,
    status,
    apply_end
  from grants
  where status in ('open', 'upcoming')
    or ($1::boolean and status = 'closed')
),
criteria_stats as (
  select
    criteria.grant_id,
    count(*) filter (where criteria.needs_review)::int as needs_review_count
  from grant_criteria criteria
  join target_grants g on g.id = criteria.grant_id
  group by criteria.grant_id
),
attachment_stats as (
  select
    attachment.source,
    attachment.source_id,
    count(*) filter (
      where attachment.conversion_status = 'failed'
    )::int as attachment_failed_count,
    count(*) filter (
      where attachment.conversion_status is null
        or attachment.conversion_status not in ('converted', 'skipped')
    )::int as attachment_unresolved_count
  from grant_attachment_archives attachment
  join target_grants g
    on g.source = attachment.source and g.source_id = attachment.source_id
  group by attachment.source, attachment.source_id
),
surface_stats as (
  select
    surface.grant_id,
    count(*) filter (
      where surface.extraction_status = 'failed'
    )::int as surface_failed_count
  from grant_application_surfaces surface
  join target_grants g on g.id = surface.grant_id
  group by surface.grant_id
),
latest_extraction as (
  select distinct on (extraction.grant_id)
    extraction.grant_id,
    extraction.status::text as extraction_status
  from extraction_log extraction
  join target_grants g on g.id = extraction.grant_id
  order by extraction.grant_id, extraction.ts desc, extraction.id desc
),
summary_base as (
  select
    g.source::text as source,
    gr.status::text as pipeline_status,
    ${PIPELINE_DEADLINE_BUCKET_SQL} as deadline_bucket,
    ${PIPELINE_MANAGEMENT_STATE_SQL} as management_state
  from target_grants g
  left join grant_raw gr
    on gr.source = g.source and gr.source_id = g.source_id
  left join criteria_stats cs on cs.grant_id = g.id
  left join attachment_stats ast
    on ast.source = g.source and ast.source_id = g.source_id
  left join surface_stats ss on ss.grant_id = g.id
  left join latest_extraction le on le.grant_id = g.id
)
`

interface CriteriaSummaryRow {
  dimension?: unknown
  value?: unknown
  needsReview?: unknown
}

interface PipelineBaseRow {
  grant_id: string
  source: string
  source_id: string
  title: string
  url: string | null
  agency: string | null
  apply_start: Date | null
  apply_end: Date | null
  grant_status: string
  updated_at: Date
  parser_version: string | null
  model_ver: string | null
  prompt_ver: string | null
  pipeline_status: string | null
  collected_at: Date | null
  criteria_count: number
  needs_review_count: number
  criteria_summary: CriteriaSummaryRow[]
  attachment_count: number
  attachment_problem_count: number
  attachment_failed_count: number
  attachment_unresolved_count: number
  surface_failed_count: number
  extraction_status: string | null
  extraction_at: Date | null
  d_day: number | null
  deadline_bucket: string
  management_state: string
}

interface SourceHealthRow {
  source: string
  open_count: number
  today_new_count: number
  last_collected_at: Date | null
}

interface PipelineSummaryAggregateRow {
  source: string
  management_state: string
  pipeline_status: string | null
  deadline_bucket: string
  count: number
}

interface ApplicationPrecomputeSummaryRow {
  total_jobs: number
  queued: number
  running: number
  succeeded: number
  needs_attention: number
  source_count: number
  document_count: number
  field_count: number
  cost_usd: string | number | null
  worker_status: string | null
  worker_heartbeat_at: Date | null
}

interface CountRow {
  value: number
}

interface AttachmentStatusRow {
  status: string
  count: number
  notice_count: number
}

interface CriterionDetailRow {
  id: string
  dimension: string
  operator: string
  kind: string
  value: Record<string, unknown>
  confidence: number
  raw_text: string | null
  source_span: string | null
  needs_review: boolean
  parser_version: string | null
}

interface AttachmentDetailRow {
  id: string
  filename: string
  content_type: string | null
  bytes: number | null
  conversion_status: string | null
  markdown_url: string | null
  conversion_error: string | null
  converter: string | null
  converted_at: Date | null
  updated_at: Date
}

interface SurfaceDetailRow {
  id: string
  title: string
  type: string
  format: string
  extraction_status: string
  extraction_version: string | null
  confidence: number | null
  source_url: string | null
  updated_at: Date
  precompute_job_id: string | null
  precompute_status: string | null
  precompute_result_status: string | null
  precompute_analysis_version: string | null
  precompute_source_sha256: string | null
  precompute_summary: Record<string, unknown> | null
  precompute_request_count: number | null
  precompute_input_tokens: number | null
  precompute_output_tokens: number | null
  precompute_cost_usd: string | number | null
  precompute_error_code: string | null
  precompute_error_message: string | null
  precompute_started_at: Date | null
  precompute_completed_at: Date | null
}

interface DeepAnalysisPairRow {
  job_id: string | null
  job_status: string | null
  run_id: string | null
  run_status: string | null
  model: string | null
  cost_usd: string | number | null
  error_code: string | null
  started_at: Date | null
  completed_at: Date | null
}

interface ApplicationPrecomputePairRow {
  source_count: number
  job_count: number
  completed_count: number
  field_count: number
  cost_usd: string | number | null
  latest_status: string | null
  latest_result_status: string | null
  analysis_version: string | null
  error_code: string | null
  started_at: Date | null
  completed_at: Date | null
}

interface HistoryDetailRow {
  id: string
  status: string
  confidence: number
  model_ver: string
  prompt_ver: string
  reviewer: string | null
  ts: Date
}

interface AdminActionDetailRow {
  id: string
  request_id: string
  action: string
  status: string
  actor_email: string
  result: Record<string, unknown>
  error: string | null
  created_at: Date
  completed_at: Date | null
}

interface GoldenSetDetailRow {
  id: string
  ref: string
  golden_ver: string
}

export interface ManagementStateInput {
  grantStatus: string
  pipelineStatus: string | null
  attachmentFailedCount: number
  attachmentUnresolvedCount: number
  surfaceFailedCount: number
  needsReviewCount: number
  extractionStatus: string | null
}

export class PipelineGraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "PipelineGraphError"
  }
}

export function deriveManagementState(input: ManagementStateInput): ManagementState {
  if (input.grantStatus === "closed") return "closed"
  if (
    input.pipelineStatus === "failed"
    || input.attachmentFailedCount > 0
    || input.surfaceFailedCount > 0
  ) {
    return "failed"
  }
  if (input.needsReviewCount > 0 || input.extractionStatus === "review") {
    return "needs_admin"
  }
  if (
    input.pipelineStatus === null
    || ["fetched", "converted", "extracted", "normalized"].includes(input.pipelineStatus)
  ) {
    return "in_pipeline"
  }
  if (
    input.pipelineStatus === "published"
    && input.extractionStatus === "labeled"
    && input.attachmentUnresolvedCount === 0
  ) {
    return "ok"
  }
  if (input.pipelineStatus === "published") return "auto_reviewable"
  return "in_pipeline"
}

export function parsePipelineQuery(params: URLSearchParams): PipelineQueryState {
  const lensValue = params.get("lens")
  const lens = isPipelineLens(lensValue) ? lensValue : "review"
  const sourceValue = params.get("source")
  const source = isPipelineSource(sourceValue) ? sourceValue : null
  const sortValue = params.get("sort")
  const sort = isPipelineSort(sortValue) ? sortValue : "deadline"
  const rawBucket = params.get("bucket")
  const bucket = params.has("bucket")
    ? validBucketForLens(lens, rawBucket) ? rawBucket : null
    : lens === "review" ? "needs_admin" : null
  const q = (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH)
  const pageValue = Number(params.get("page") ?? "1")
  const page = Number.isSafeInteger(pageValue) && pageValue >= 1 && pageValue <= MAX_PAGE
    ? pageValue
    : 1

  return {
    lens,
    source,
    bucket,
    q,
    sort,
    page,
    includeClosed: params.get("closed") === "include",
  }
}

export async function getPipelineSummary(
  input: Pick<PipelineQueryState, "lens" | "includeClosed">,
): Promise<PipelineSummary> {
  const sql = getAdminSql()
  const [rows, sourceRows, applicationPrecomputeRows] = await Promise.all([
    sql.unsafe<PipelineSummaryAggregateRow[]>(
      `${PIPELINE_SUMMARY_CTE}
      select
        source,
        management_state,
        pipeline_status,
        deadline_bucket,
        count(*)::int as count
      from summary_base
      group by source, management_state, pipeline_status, deadline_bucket`,
      [input.includeClosed],
    ),
    loadSourceHealth(sql),
    loadApplicationPrecomputeSummary(sql),
  ])

  return buildPipelineSummary({
    rows,
    sourceRows,
    applicationPrecompute: applicationPrecomputeRows[0],
    lens: input.lens,
  })
}

export async function getPipelineNotices(
  input: PipelineQueryState,
): Promise<PipelineNoticesResult> {
  const sql = getAdminSql()
  const sourceCondition = input.source
    ? sql`and source = ${input.source}`
    : sql``
  const bucketCondition = bucketConditionFor(sql, input.lens, input.bucket)
  const searchCondition = input.q
    ? sql`and (
        title ilike ${likePattern(input.q)} escape E'\\\\'
        or source_id ilike ${likePattern(input.q)} escape E'\\\\'
        or coalesce(agency, '') ilike ${likePattern(input.q)} escape E'\\\\'
      )`
    : sql``
  const orderBy = orderByFor(sql, input.sort)
  const offset = (input.page - 1) * PAGE_SIZE

  const [countRows, pageRows] = await Promise.all([
    sql<CountRow[]>`
      ${sql.unsafe(PIPELINE_BASE_CTE)}
      select count(*)::int as value
      from pipeline_base
      where (
          grant_status in ('open', 'upcoming')
          or (${input.includeClosed} and grant_status = 'closed')
        )
        ${sourceCondition}
        ${bucketCondition}
        ${searchCondition}
    `,
    sql<PipelineBaseRow[]>`
      ${sql.unsafe(PIPELINE_BASE_CTE)}
      select *
      from pipeline_base
      where (
          grant_status in ('open', 'upcoming')
          or (${input.includeClosed} and grant_status = 'closed')
        )
        ${sourceCondition}
        ${bucketCondition}
        ${searchCondition}
      order by ${orderBy}
      limit ${PAGE_SIZE}
      offset ${offset}
    `,
  ])

  const total = countRows[0]?.value ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return {
    generatedAt: new Date().toISOString(),
    total,
    page: input.page,
    pageSize: PAGE_SIZE,
    pageCount,
    hasPrevious: input.page > 1,
    hasNext: input.page < pageCount,
    items: pageRows.map(toNoticeItem),
  }
}

export async function getPipelineNoticeDetail(input: {
  source: string
  sourceId: string
}): Promise<PipelineNoticeDetail> {
  if (!isPipelineSource(input.source)) {
    throw new PipelineGraphError("invalid_pipeline_source", "지원하지 않는 공고 소스입니다.", 400)
  }
  const sourceId = input.sourceId.trim()
  if (!sourceId || sourceId.length > 240) {
    throw new PipelineGraphError("invalid_pipeline_source_id", "올바른 sourceId가 필요합니다.", 400)
  }

  const sql = getAdminSql()
  const baseRows = await sql<PipelineBaseRow[]>`
    ${sql.unsafe(PIPELINE_BASE_CTE)}
    select *
    from pipeline_base
    where source = ${input.source}
      and source_id = ${sourceId}
    limit 1
  `
  const base = baseRows[0]
  if (!base) {
    throw new PipelineGraphError("pipeline_notice_not_found", "공고를 찾지 못했습니다.", 404)
  }

  const [
    criteriaRows,
    attachmentRows,
    surfaceRows,
    historyRows,
    adminActionRows,
    goldenSetRows,
    deepAnalysisRows,
    applicationPrecomputeRows,
  ] = await Promise.all([
    sql<CriterionDetailRow[]>`
      select
        id,
        dimension::text,
        operator::text,
        kind::text,
        value,
        confidence,
        raw_text,
        source_span,
        needs_review,
        parser_version
      from grant_criteria
      where grant_id = ${base.grant_id}
      order by dimension, id
    `,
    sql<AttachmentDetailRow[]>`
      select
        id,
        filename,
        content_type,
        bytes,
        conversion_status,
        markdown_url,
        conversion_error,
        converter,
        converted_at,
        updated_at
      from grant_attachment_archives
      where source = ${input.source}
        and source_id = ${sourceId}
      order by filename, id
    `,
    sql<SurfaceDetailRow[]>`
      select
        surface.id,
        surface.title,
        surface.type,
        surface.format,
        surface.extraction_status,
        surface.extraction_version,
        surface.confidence,
        surface.source_url,
        surface.updated_at,
        precompute.id as precompute_job_id,
        precompute.status as precompute_status,
        precompute.result_status as precompute_result_status,
        precompute.analysis_version as precompute_analysis_version,
        precompute.source_sha256 as precompute_source_sha256,
        precompute.result_summary as precompute_summary,
        precompute.request_count as precompute_request_count,
        precompute.input_tokens as precompute_input_tokens,
        precompute.output_tokens as precompute_output_tokens,
        precompute.cost_usd as precompute_cost_usd,
        precompute.last_error_code as precompute_error_code,
        precompute.last_error_message as precompute_error_message,
        precompute.started_at as precompute_started_at,
        precompute.completed_at as precompute_completed_at
      from grant_application_surfaces surface
      left join lateral (
        select job.*
        from grant_application_precompute_jobs job
        where job.surface_id = surface.id
        order by job.created_at desc, job.id desc
        limit 1
      ) precompute on true
      where surface.grant_id = ${base.grant_id}
      order by surface.updated_at desc, surface.id
    `,
    sql<HistoryDetailRow[]>`
      select
        id,
        status::text,
        confidence,
        model_ver,
        prompt_ver,
        reviewer::text,
        ts
      from extraction_log
      where grant_id = ${base.grant_id}
      order by ts desc, id desc
      limit 50
    `,
    sql<AdminActionDetailRow[]>`
      select
        action_log.id,
        action_log.request_id,
        action_log.action,
        action_log.status,
        admin_user.email as actor_email,
        action_log.result,
        action_log.error,
        action_log.created_at,
        action_log.completed_at
      from admin_pipeline_actions action_log
      join admin_users admin_user on admin_user.id = action_log.admin_user_id
      where action_log.grant_id = ${base.grant_id}
      order by action_log.created_at desc, action_log.id desc
      limit 50
    `,
    sql<GoldenSetDetailRow[]>`
      select id, ref, golden_ver
      from golden_set
      where kind = 'extraction'
        and ref in (
          ${base.grant_id},
          ${`grant:${base.grant_id}`},
          ${`${base.source}:${base.source_id}`}
        )
      order by golden_ver desc, id
    `,
    sql<DeepAnalysisPairRow[]>`
      select
        job.id as job_id,
        job.status as job_status,
        run.run_id,
        run.status as run_status,
        run.model,
        run.cost_usd,
        coalesce(run.error_code, job.last_error_code) as error_code,
        run.started_at,
        run.completed_at
      from grant_deep_analysis_jobs job
      left join lateral (
        select latest_run.*
        from grant_deep_analysis_runs latest_run
        where latest_run.job_id = job.id
        order by latest_run.started_at desc, latest_run.id desc
        limit 1
      ) run on true
      where job.grant_id = ${base.grant_id}
      order by job.created_at desc, job.id desc
      limit 1
    `,
    sql<ApplicationPrecomputePairRow[]>`
      with jobs as (
        select job.*,
          row_number() over (order by job.created_at desc, job.id desc) as newest
        from grant_application_precompute_jobs job
        where job.grant_id = ${base.grant_id}
      )
      select
        count(distinct surface_id)::int as source_count,
        count(*)::int as job_count,
        count(*) filter (where status = 'succeeded')::int as completed_count,
        coalesce(sum((result_summary->>'fieldCount')::int), 0)::int as field_count,
        sum(cost_usd) as cost_usd,
        max(status) filter (where newest = 1) as latest_status,
        max(result_status) filter (where newest = 1) as latest_result_status,
        max(analysis_version) filter (where newest = 1) as analysis_version,
        max(last_error_code) filter (where newest = 1) as error_code,
        min(started_at) as started_at,
        max(completed_at) as completed_at
      from jobs
    `,
  ])

  const notice = toNoticeItem(base)
  return {
    notice: {
      ...notice,
      url: base.url,
      parserVersion: base.parser_version,
      modelVer: base.model_ver,
      promptVer: base.prompt_ver,
      collectedAt: dateString(base.collected_at),
      demoHref: `${webOrigin()}/grants/${encodeURIComponent(base.grant_id)}`,
    },
    criteria: criteriaRows.map(toCriterionDetail),
    attachments: attachmentRows.map(toAttachmentDetail),
    surfaces: surfaceRows.map(toSurfaceDetail),
    analyses: toAnalysisPairDetail(deepAnalysisRows[0], applicationPrecomputeRows[0]),
    history: historyRows.map(toHistoryDetail),
    adminActions: adminActionRows.map(toAdminActionDetail),
    goldenSet: goldenSetRows.map(toGoldenSetDetail),
  }
}

export async function getPipelineMeasurement(): Promise<PipelineMeasurement> {
  const sql = getAdminSql()
  return sql.begin("read only", async (tx) => {
    const [baseRows, attachmentStatuses, attachmentNoticeRows] = await Promise.all([
      tx.unsafe<PipelineBaseRow[]>(
        `${PIPELINE_BASE_CTE}
        select *
        from pipeline_base
        where grant_status in ('open', 'upcoming')`,
      ),
      tx<AttachmentStatusRow[]>`
        select
          coalesce(a.conversion_status, '(null)') as status,
          count(*)::int as count,
          count(distinct (a.source, a.source_id))::int as notice_count
        from grant_attachment_archives a
        join grants g
          on g.source = a.source and g.source_id = a.source_id
        where g.status in ('open', 'upcoming')
        group by coalesce(a.conversion_status, '(null)')
        order by count(*) desc
      `,
      tx<CountRow[]>`
        select count(distinct (a.source, a.source_id))::int as value
        from grant_attachment_archives a
        join grants g
          on g.source = a.source and g.source_id = a.source_id
        where g.status in ('open', 'upcoming')
      `,
    ])

    const needsReviewCounts = baseRows
      .map((row) => row.needs_review_count)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    const managementStates = zeroRecord(MANAGEMENT_STATES)
    const sources = zeroRecord(PIPELINE_SOURCES)
    const rawStatuses: Record<string, number> = {}
    const extractionHistory: Record<string, number> = {}

    for (const row of baseRows) {
      if (isManagementState(row.management_state)) {
        managementStates[row.management_state] += 1
      }
      if (isPipelineSource(row.source)) sources[row.source] += 1
      increment(rawStatuses, row.pipeline_status ?? "(missing)")
      increment(extractionHistory, row.extraction_status ?? "(none)")
    }

    const attachmentStatusRecord: Record<string, number> = {}
    for (const row of attachmentStatuses) {
      attachmentStatusRecord[row.status] = row.count
    }

    return {
      measuredAt: new Date().toISOString(),
      activeNotices: baseRows.length,
      managementStates,
      sources,
      rawStatuses,
      attachmentStatuses: attachmentStatusRecord,
      needsReview: {
        noticeCount: needsReviewCounts.length,
        rowCount: needsReviewCounts.reduce((total, value) => total + value, 0),
        p50RowsPerNotice: percentile(needsReviewCounts, 0.5),
        p95RowsPerNotice: percentile(needsReviewCounts, 0.95),
        maxRowsPerNotice: needsReviewCounts.at(-1) ?? 0,
      },
      attachments: {
        noticeCount: attachmentNoticeRows[0]?.value ?? 0,
        failedNoticeCount: attachmentStatuses.find((row) => row.status === "failed")?.notice_count ?? 0,
        nullStatusCount: attachmentStatuses.find((row) => row.status === "(null)")?.count ?? 0,
        totalCount: attachmentStatuses.reduce((total, row) => total + row.count, 0),
      },
      extractionHistory,
    }
  })
}

function buildPipelineSummary(input: {
  rows: PipelineSummaryAggregateRow[]
  sourceRows: SourceHealthRow[]
  applicationPrecompute: ApplicationPrecomputeSummaryRow | undefined
  lens: PipelineLens
}): PipelineSummary {
  const bucketKeys = bucketKeysForLens(input.lens)
  const buckets = new Map<PipelineBucket, PipelineBucketSummary>()
  for (const key of bucketKeys) {
    buckets.set(key, {
      key,
      label: labelForPipelineBucket(input.lens, key),
      count: 0,
      bySource: zeroRecord(PIPELINE_SOURCES),
    })
  }

  for (const row of input.rows) {
    const source = isPipelineSource(row.source) ? row.source : null
    const bucket = bucketForRow(row, input.lens)
    const summary = bucket ? buckets.get(bucket) : null
    if (!summary || !source) continue
    summary.count += row.count
    summary.bySource[source] += row.count
  }

  const sourceByKey = new Map(
    input.sourceRows
      .filter((row): row is SourceHealthRow & { source: PipelineSource } => isPipelineSource(row.source))
      .map((row) => [row.source, row]),
  )
  const now = Date.now()
  const staleHours = staleThresholdHours()
  const sources: PipelineSourceSummary[] = PIPELINE_SOURCES.map((source) => {
    const row = sourceByKey.get(source)
    const lastCollectedAt = dateString(row?.last_collected_at ?? null)
    const lastCollectedTime = row?.last_collected_at?.getTime()
    return {
      source,
      label: PIPELINE_SOURCE_LABELS[source],
      openCount: row?.open_count ?? 0,
      todayNewCount: row?.today_new_count ?? 0,
      lastCollectedAt,
      stale: lastCollectedTime === undefined
        || now - lastCollectedTime > staleHours * 60 * 60 * 1000,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    lens: input.lens,
    total: input.rows.reduce((total, row) => total + row.count, 0),
    sources,
    buckets: [...buckets.values()],
    applicationPrecompute: {
      totalJobs: input.applicationPrecompute?.total_jobs ?? 0,
      queued: input.applicationPrecompute?.queued ?? 0,
      running: input.applicationPrecompute?.running ?? 0,
      succeeded: input.applicationPrecompute?.succeeded ?? 0,
      needsAttention: input.applicationPrecompute?.needs_attention ?? 0,
      sourceCount: input.applicationPrecompute?.source_count ?? 0,
      documentCount: input.applicationPrecompute?.document_count ?? 0,
      fieldCount: input.applicationPrecompute?.field_count ?? 0,
      costUsd: nullableNumber(input.applicationPrecompute?.cost_usd),
      workerStatus: input.applicationPrecompute?.worker_status ?? null,
      workerHeartbeatAt: dateString(input.applicationPrecompute?.worker_heartbeat_at ?? null),
      workerStale: !input.applicationPrecompute?.worker_heartbeat_at
        || Date.now() - input.applicationPrecompute.worker_heartbeat_at.getTime() > 15 * 60 * 1_000,
    },
    refreshAfterSeconds: REFRESH_AFTER_SECONDS,
  }
}

async function loadApplicationPrecomputeSummary(
  sql: postgres.Sql,
): Promise<ApplicationPrecomputeSummaryRow[]> {
  return sql<ApplicationPrecomputeSummaryRow[]>`
    WITH target_jobs AS (
      SELECT job.*
      FROM grant_application_precompute_jobs job
      JOIN grants grant_row ON grant_row.id = job.grant_id
      WHERE grant_row.serving_state = 'visible'
        AND grant_row.status IN ('open', 'upcoming')
    ), latest_worker AS (
      SELECT status, heartbeat_at
      FROM grant_application_precompute_worker_heartbeats
      ORDER BY heartbeat_at DESC
      LIMIT 1
    )
    SELECT
      count(*)::int AS total_jobs,
      count(*) FILTER (WHERE job.status IN ('pending', 'retry_wait'))::int AS queued,
      count(*) FILTER (WHERE job.status = 'leased')::int AS running,
      count(*) FILTER (WHERE job.status = 'succeeded')::int AS succeeded,
      count(*) FILTER (WHERE job.status IN ('blocked', 'dead_letter'))::int AS needs_attention,
      count(DISTINCT job.surface_id)::int AS source_count,
      coalesce(sum((job.result_summary->>'documentCount')::int), 0)::int AS document_count,
      coalesce(sum((job.result_summary->>'fieldCount')::int), 0)::int AS field_count,
      sum(job.cost_usd) AS cost_usd,
      (SELECT status FROM latest_worker) AS worker_status,
      (SELECT heartbeat_at FROM latest_worker) AS worker_heartbeat_at
    FROM target_jobs job
  `
}

async function loadSourceHealth(sql: postgres.Sql): Promise<SourceHealthRow[]> {
  return sql<SourceHealthRow[]>`
    with sources(source) as (
      values
        ('kstartup'::grant_source),
        ('bizinfo'::grant_source),
        ('bizinfo_event'::grant_source)
    ),
    raw_stats as (
      select
        source,
        max(collected_at) as last_collected_at,
        count(*) filter (
          where timezone('Asia/Seoul', collected_at)::date
            = timezone('Asia/Seoul', now())::date
        )::int as today_new_count
      from grant_raw
      group by source
    ),
    grant_stats as (
      select
        source,
        count(*) filter (where status in ('open', 'upcoming'))::int as open_count
      from grants
      group by source
    )
    select
      sources.source::text as source,
      coalesce(grant_stats.open_count, 0)::int as open_count,
      coalesce(raw_stats.today_new_count, 0)::int as today_new_count,
      greatest(source_cursor.last_collected_at, raw_stats.last_collected_at) as last_collected_at
    from sources
    left join source_cursor on source_cursor.source = sources.source
    left join raw_stats on raw_stats.source = sources.source
    left join grant_stats on grant_stats.source = sources.source
    order by sources.source
  `
}

function toNoticeItem(row: PipelineBaseRow): PipelineNoticeItem {
  if (!isPipelineSource(row.source)) {
    throw new PipelineGraphError("invalid_pipeline_row_source", "DB 공고 소스가 계약과 다릅니다.", 500)
  }
  if (!isManagementState(row.management_state)) {
    throw new PipelineGraphError("invalid_management_state", "DB 관리 상태가 계약과 다릅니다.", 500)
  }

  return {
    grantId: row.grant_id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    agency: row.agency,
    applyStart: dateString(row.apply_start),
    applyEnd: dateString(row.apply_end),
    dDay: row.d_day,
    managementState: row.management_state,
    pipelineStatus: isPipelineStatus(row.pipeline_status) ? row.pipeline_status : null,
    attachmentCount: row.attachment_count,
    attachmentProblemCount: row.attachment_problem_count,
    criteriaFilledCount: row.criteria_count,
    needsReviewCount: row.needs_review_count,
    criteriaDots: buildCriteriaDots(row.criteria_summary),
    updatedAt: row.updated_at.toISOString(),
  }
}

function buildCriteriaDots(rows: CriteriaSummaryRow[]): PipelineCriterionDot[] {
  const grouped = new Map<string, { values: unknown[]; needsReview: boolean }>()
  for (const row of rows) {
    if (typeof row.dimension !== "string") continue
    const current = grouped.get(row.dimension) ?? { values: [], needsReview: false }
    current.values.push(row.value)
    current.needsReview = current.needsReview || row.needsReview === true
    grouped.set(row.dimension, current)
  }

  return PIPELINE_CRITERION_DIMENSIONS.map((dimension) => {
    const summary = grouped.get(dimension)
    return {
      dimension,
      label: CRITERION_DIMENSION_LABELS[dimension],
      filled: Boolean(summary),
      needsReview: summary?.needsReview ?? false,
      valueLabel: summary ? summary.values.map(formatCriterionValue).join(" · ") : null,
    }
  })
}

function toCriterionDetail(row: CriterionDetailRow): PipelineCriterionDetail {
  if (!(row.dimension in CRITERION_DIMENSION_LABELS)) {
    throw new PipelineGraphError("invalid_criterion_dimension", "DB criteria 차원이 계약과 다릅니다.", 500)
  }
  const dimension = row.dimension as keyof typeof CRITERION_DIMENSION_LABELS
  return {
    id: row.id,
    dimension,
    label: CRITERION_DIMENSION_LABELS[dimension],
    operator: row.operator,
    kind: row.kind,
    value: row.value,
    valueLabel: formatCriterionValue(row.value),
    confidence: row.confidence,
    rawText: row.raw_text,
    sourceSpan: row.source_span,
    needsReview: row.needs_review,
    parserVersion: row.parser_version,
  }
}

function toAttachmentDetail(row: AttachmentDetailRow): PipelineAttachmentDetail {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    bytes: row.bytes,
    conversionStatus: row.conversion_status,
    markdownUrl: row.markdown_url,
    conversionError: row.conversion_error,
    converter: row.converter,
    convertedAt: dateString(row.converted_at),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toSurfaceDetail(row: SurfaceDetailRow): PipelineSurfaceDetail {
  const summary = row.precompute_summary ?? {}
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    format: row.format,
    extractionStatus: row.extraction_status,
    extractionVersion: row.extraction_version,
    confidence: row.confidence,
    sourceUrl: row.source_url,
    applicationPrecompute: row.precompute_job_id
      && row.precompute_status
      && row.precompute_analysis_version
      && row.precompute_source_sha256
      ? {
        jobId: row.precompute_job_id,
        status: row.precompute_status,
        resultStatus: row.precompute_result_status,
        analysisVersion: row.precompute_analysis_version,
        sourceSha256: row.precompute_source_sha256,
        model: stringValue(summary.model),
        transport: stringValue(summary.transport),
        fieldCount: integerValue(summary.fieldCount),
        candidateCount: integerValue(summary.candidateCount),
        requestCount: row.precompute_request_count ?? 0,
        inputTokens: row.precompute_input_tokens ?? 0,
        outputTokens: row.precompute_output_tokens ?? 0,
        costUsd: nullableNumber(row.precompute_cost_usd),
        errorCode: row.precompute_error_code,
        errorMessage: row.precompute_error_message,
        startedAt: dateString(row.precompute_started_at),
        completedAt: dateString(row.precompute_completed_at),
      }
      : null,
    updatedAt: row.updated_at.toISOString(),
  }
}

function toAnalysisPairDetail(
  deep: DeepAnalysisPairRow | undefined,
  precompute: ApplicationPrecomputePairRow | undefined,
): PipelineAnalysisPairDetail {
  return {
    deepAnalysis: {
      jobId: deep?.job_id ?? null,
      jobStatus: deep?.job_status ?? null,
      runId: deep?.run_id ?? null,
      runStatus: deep?.run_status ?? null,
      model: deep?.model ?? null,
      costUsd: nullableNumber(deep?.cost_usd),
      errorCode: deep?.error_code ?? null,
      startedAt: dateString(deep?.started_at ?? null),
      completedAt: dateString(deep?.completed_at ?? null),
    },
    applicationPrecompute: {
      sourceCount: precompute?.source_count ?? 0,
      jobCount: precompute?.job_count ?? 0,
      completedCount: precompute?.completed_count ?? 0,
      fieldCount: precompute?.field_count ?? 0,
      costUsd: nullableNumber(precompute?.cost_usd),
      latestStatus: precompute?.latest_status ?? null,
      latestResultStatus: precompute?.latest_result_status ?? null,
      analysisVersion: precompute?.analysis_version ?? null,
      errorCode: precompute?.error_code ?? null,
      startedAt: dateString(precompute?.started_at ?? null),
      completedAt: dateString(precompute?.completed_at ?? null),
    },
  }
}

function toHistoryDetail(row: HistoryDetailRow): PipelineHistoryDetail {
  return {
    id: row.id,
    status: row.status,
    confidence: row.confidence,
    modelVer: row.model_ver,
    promptVer: row.prompt_ver,
    reviewer: row.reviewer,
    at: row.ts.toISOString(),
  }
}

function toAdminActionDetail(row: AdminActionDetailRow): PipelineAdminActionDetail {
  if (row.action !== "mark_reviewed" && row.action !== "reconvert") {
    throw new PipelineGraphError("invalid_pipeline_action", "DB 관리자 액션이 계약과 다릅니다.", 500)
  }
  if (
    row.status !== "queued"
    && row.status !== "succeeded"
    && row.status !== "partial"
    && row.status !== "failed"
  ) {
    throw new PipelineGraphError("invalid_pipeline_action_status", "DB 관리자 액션 상태가 계약과 다릅니다.", 500)
  }
  return {
    id: row.id,
    requestId: row.request_id,
    action: row.action,
    status: row.status,
    actorEmail: row.actor_email,
    result: row.result,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: dateString(row.completed_at),
  }
}

function toGoldenSetDetail(row: GoldenSetDetailRow): PipelineGoldenSetDetail {
  return {
    id: row.id,
    ref: row.ref,
    goldenVer: row.golden_ver,
  }
}

function bucketKeysForLens(lens: PipelineLens): PipelineBucket[] {
  if (lens === "review") return [...MANAGEMENT_STATES]
  if (lens === "pipeline") return [...PIPELINE_STATUSES]
  return [...DEADLINE_BUCKETS]
}

function bucketForRow(
  row: Pick<
    PipelineBaseRow,
    "management_state" | "pipeline_status" | "deadline_bucket"
  >,
  lens: PipelineLens,
): PipelineBucket | null {
  if (lens === "review") {
    return isManagementState(row.management_state) ? row.management_state : null
  }
  if (lens === "pipeline") {
    return isPipelineStatus(row.pipeline_status) ? row.pipeline_status : null
  }
  return isDeadlineBucket(row.deadline_bucket) ? row.deadline_bucket : null
}

function validBucketForLens(
  lens: PipelineLens,
  value: string | null,
): value is PipelineBucket {
  if (!isPipelineBucket(value)) return false
  if (lens === "review") return isManagementState(value)
  if (lens === "pipeline") return isPipelineStatus(value)
  return isDeadlineBucket(value)
}

function bucketConditionFor(
  sql: postgres.Sql,
  lens: PipelineLens,
  bucket: PipelineBucket | null,
) {
  if (!bucket) return sql``
  if (lens === "review" && isManagementState(bucket)) {
    return sql`and management_state = ${bucket}`
  }
  if (lens === "pipeline" && isPipelineStatus(bucket)) {
    return sql`and pipeline_status = ${bucket}`
  }
  if (lens === "deadline" && isDeadlineBucket(bucket)) {
    return sql`and deadline_bucket = ${bucket}`
  }
  return sql``
}

function orderByFor(sql: postgres.Sql, sort: PipelineSort) {
  if (sort === "review") {
    return sql`needs_review_count desc, apply_end asc nulls last, grant_id asc`
  }
  if (sort === "attachments") {
    return sql`attachment_problem_count desc, apply_end asc nulls last, grant_id asc`
  }
  return sql`apply_end asc nulls last, grant_id asc`
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`
}

function formatCriterionValue(value: unknown): string {
  if (value === null || value === undefined) return "값 없음"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (Array.isArray(value)) return value.map(formatCriterionValue).join(", ")
  if (typeof value !== "object") return String(value)

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return "값 없음"
  return entries
    .map(([key, entryValue]) => `${key}: ${formatCriterionValue(entryValue)}`)
    .join(", ")
}

function dateString(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function zeroRecord<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)
  return values[index] ?? 0
}

function staleThresholdHours(): number {
  const parsed = Number.parseInt(process.env.CUNOTE_PIPELINE_STALE_HOURS ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 26
}

function webOrigin(): string {
  const value = process.env.NEXT_PUBLIC_WEB_URL?.trim()
    || process.env.WEB_APP_URL?.trim()
    || "https://changupnote.com"
  return value.replace(/\/+$/, "")
}
