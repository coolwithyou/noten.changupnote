import type postgres from "postgres"

import {
  isPipelineAction,
  isPipelineSource,
  type PipelineAction,
  type PipelineActionRequest,
  type PipelineActionResponse,
  type PipelineActionTarget,
  type PipelineActionTargetResult,
  type PipelineSource,
} from "@/features/pipeline/contract"
import { getAdminSql } from "@/lib/server/db/client"
import { createRegistryStorageFromEnv } from "@/lib/server/storage/r2RegistryStorage"

const MAX_TARGETS = 50
const MAX_RECONVERT_ATTACHMENTS = 100
const CONVERSION_REQUESTED_ARTIFACTS = ["pdf", "page_images", "markdown", "hwpx"] as const
const CONVERSION_VERSION = "conv-2026.07-lo26.2-h2o0.7.13"
type QuerySql = postgres.Sql | postgres.TransactionSql

interface GrantActionRow {
  position: number
  grant_id: string
  source: PipelineSource
  source_id: string
  title: string
  model_ver: string | null
  prompt_ver: string | null
  attachment_ids: string[] | null
}

interface AuditRow {
  id: string
  grant_id: string
  source: PipelineSource
  source_id: string
  grant_title: string
  status: "queued" | "succeeded" | "partial" | "failed"
  result: Record<string, unknown>
  error: string | null
}

interface UpdatedCriterionRow {
  grant_id: string
}

interface ReconvertAttachmentRow {
  grant_id: string
  source: PipelineSource
  source_id: string
  attachment_id: string
  filename: string
  storage_key: string | null
  archive_url: string | null
  source_uri: string
  sha256: string | null
  surface_id: string | null
}

interface PreparedConversion {
  grantId: string
  source: PipelineSource
  sourceId: string
  attachmentId: string
  filename: string
  storageKey: string | null
  archiveUrl: string | null
  sourceUri: string
  sha256: string
  surfaceId: string
}

interface ConversionEnqueueResponse {
  jobId: string
  status: "queued" | "running" | "succeeded" | "partial" | "failed"
  cached: boolean
}

export class PipelineActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "PipelineActionError"
  }
}

export function parsePipelineActionRequest(body: unknown): PipelineActionRequest {
  if (!body || typeof body !== "object") {
    throw new PipelineActionError("invalid_pipeline_action", "액션 요청 본문이 필요합니다.", 400)
  }
  const value = body as Record<string, unknown>
  const action = typeof value.action === "string" && isPipelineAction(value.action)
    ? value.action
    : null
  if (!action) {
    throw new PipelineActionError("invalid_pipeline_action", "지원하지 않는 공고 관제 액션입니다.", 400)
  }
  if (typeof value.requestId !== "string" || !isUuid(value.requestId)) {
    throw new PipelineActionError("invalid_pipeline_request_id", "올바른 requestId가 필요합니다.", 400)
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > MAX_TARGETS) {
    throw new PipelineActionError(
      "invalid_pipeline_targets",
      `대상은 1~${MAX_TARGETS}건이어야 합니다.`,
      400,
    )
  }

  const targets: PipelineActionTarget[] = []
  const seen = new Set<string>()
  for (const raw of value.targets) {
    if (!raw || typeof raw !== "object") {
      throw new PipelineActionError("invalid_pipeline_target", "올바른 공고 대상이 필요합니다.", 400)
    }
    const target = raw as Record<string, unknown>
    const source = typeof target.source === "string" && isPipelineSource(target.source)
      ? target.source
      : null
    const sourceId = typeof target.sourceId === "string" ? target.sourceId.trim() : ""
    if (!source || !sourceId || sourceId.length > 240) {
      throw new PipelineActionError("invalid_pipeline_target", "공고 source/sourceId가 올바르지 않습니다.", 400)
    }
    const key = `${source}\u0000${sourceId}`
    if (seen.has(key)) continue
    seen.add(key)
    const rawAttachmentIds = Array.isArray(target.attachmentIds) ? target.attachmentIds : []
    if (rawAttachmentIds.some((id) => typeof id !== "string" || !isUuid(id))) {
      throw new PipelineActionError("invalid_pipeline_attachment_ids", "첨부 id가 올바르지 않습니다.", 400)
    }
    const attachmentIds = [...new Set(rawAttachmentIds as string[])]
    targets.push({
      source,
      sourceId,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })
  }
  if (targets.length === 0) {
    throw new PipelineActionError("invalid_pipeline_targets", "중복되지 않은 대상이 필요합니다.", 400)
  }

  return {
    requestId: value.requestId,
    action,
    targets,
  }
}

export async function executePipelineAction(input: {
  request: PipelineActionRequest
  adminUserId: string
}): Promise<PipelineActionResponse> {
  const sql = getAdminSql()
  const grants = await loadGrantTargets(sql, input.request.targets)
  const existing = await loadExistingAuditRows(sql, input.request.requestId, input.request.action)
  if (existing.length > 0 && !hasSameGrantTargets(existing, grants)) {
    throw new PipelineActionError(
      "pipeline_request_id_reused",
      "같은 requestId를 다른 공고 대상에 다시 사용할 수 없습니다.",
      409,
    )
  }
  if (
    existing.length === grants.length
    && existing.length > 0
    && existing.every((row) => row.status !== "queued")
  ) {
    return buildResponse(input.request.requestId, input.request.action, existing.map(auditRowToResult))
  }

  if (input.request.action === "mark_reviewed") {
    return markReviewed(sql, {
      requestId: input.request.requestId,
      adminUserId: input.adminUserId,
      grants,
    })
  }
  return reconvert(sql, {
    requestId: input.request.requestId,
    adminUserId: input.adminUserId,
    grants,
  })
}

async function loadGrantTargets(
  sql: postgres.Sql,
  targets: PipelineActionTarget[],
): Promise<GrantActionRow[]> {
  const input = targets.map((target, position) => ({
    position,
    source: target.source,
    source_id: target.sourceId,
    attachment_ids: target.attachmentIds ?? null,
  }))
  const rows = await sql<GrantActionRow[]>`
    with input as (
      select *
      from jsonb_to_recordset(${sql.json(input)}::jsonb)
        as item(position int, source text, source_id text, attachment_ids jsonb)
    )
    select
      input.position,
      g.id as grant_id,
      g.source::text as source,
      g.source_id,
      g.title,
      g.model_ver,
      g.prompt_ver,
      case
        when input.attachment_ids is null then null
        else array(
          select jsonb_array_elements_text(input.attachment_ids)
        )
      end as attachment_ids
    from input
    join grants g
      on g.source::text = input.source
      and g.source_id = input.source_id
    order by input.position
  `
  if (rows.length !== targets.length) {
    const found = new Set(rows.map((row) => `${row.source}\u0000${row.source_id}`))
    const missing = targets
      .filter((target) => !found.has(`${target.source}\u0000${target.sourceId}`))
      .map((target) => `${target.source}:${target.sourceId}`)
    throw new PipelineActionError(
      "pipeline_action_target_not_found",
      `공고를 찾지 못했습니다: ${missing.join(", ")}`,
      404,
    )
  }
  return rows
}

async function loadExistingAuditRows(
  sql: QuerySql,
  requestId: string,
  action: PipelineAction,
): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select
      id,
      grant_id,
      source::text as source,
      source_id,
      grant_title,
      status,
      result,
      error
    from admin_pipeline_actions
    where request_id = ${requestId}::uuid
      and action = ${action}
    order by created_at, id
  `
}

async function markReviewed(
  sql: postgres.Sql,
  input: {
    requestId: string
    adminUserId: string
    grants: GrantActionRow[]
  },
): Promise<PipelineActionResponse> {
  const results = await sql.begin(async (tx) => {
    const insertedGrantIds = await insertQueuedAudits(tx, { ...input, action: "mark_reviewed" })
    const auditRows = await loadExistingAuditRows(tx, input.requestId, "mark_reviewed")
    if (insertedGrantIds.size === 0) {
      if (
        auditRows.length === input.grants.length
        && auditRows.every((row) => row.status !== "queued")
      ) {
        return auditRows.map(auditRowToResult)
      }
      throw new PipelineActionError(
        "pipeline_action_in_progress",
        "같은 요청이 이미 처리 중입니다.",
        409,
      )
    }
    if (insertedGrantIds.size !== input.grants.length) {
      throw new PipelineActionError(
        "pipeline_request_id_reused",
        "같은 requestId를 다른 공고 대상에 다시 사용할 수 없습니다.",
        409,
      )
    }
    const auditByGrantId = new Map(auditRows.map((row) => [row.grant_id, row]))
    const grantIds = input.grants.map((grant) => grant.grant_id)
    const updatedRows = await tx<UpdatedCriterionRow[]>`
      update grant_criteria
      set needs_review = false
      where grant_id in ${tx(grantIds)}
        and needs_review = true
      returning grant_id
    `
    const counts = countBy(updatedRows.map((row) => row.grant_id))
    const extractionEntries = input.grants.map((grant) => {
      const audit = auditByGrantId.get(grant.grant_id)
      if (!audit) {
        throw new PipelineActionError("pipeline_action_audit_missing", "감사 로그를 만들지 못했습니다.", 500)
      }
      const affectedCount = counts.get(grant.grant_id) ?? 0
      return {
        grant_id: grant.grant_id,
        input_ref: `admin:pipeline:${grant.source}:${grant.source_id}`,
        output: {
          action: "mark_reviewed",
          adminPipelineActionId: audit.id,
          reviewedCriteriaCount: affectedCount,
        },
        model_ver: grant.model_ver ?? "admin-review",
        prompt_ver: grant.prompt_ver ?? "admin-review",
      }
    })
    await tx`
      insert into extraction_log (
        grant_id,
        input_ref,
        output,
        confidence,
        status,
        reviewer,
        model_ver,
        prompt_ver,
        ts
      )
      select
        item.grant_id::uuid,
        item.input_ref,
        item.output,
        1,
        'labeled'::extraction_status,
        null,
        item.model_ver,
        item.prompt_ver,
        now()
      from jsonb_to_recordset(${tx.json(extractionEntries)}::jsonb)
        as item(
          grant_id text,
          input_ref text,
          output jsonb,
          model_ver text,
          prompt_ver text
        )
    `

    const completed = input.grants.map((grant) => {
      const affectedCount = counts.get(grant.grant_id) ?? 0
      return {
        grant_id: grant.grant_id,
        result: {
          affectedCount,
          message: affectedCount > 0
            ? `검수 플래그 ${affectedCount}건을 완료 처리했습니다.`
            : "검수 완료 상태를 기록했습니다.",
        },
      }
    })
    await completeAudits(tx, input.requestId, "mark_reviewed", completed.map((entry) => ({
      ...entry,
      status: "succeeded",
      error: null,
    })))
    return input.grants.map((grant) => {
      const completedEntry = completed.find((entry) => entry.grant_id === grant.grant_id)
      const affectedCount = numberValue(completedEntry?.result.affectedCount)
      return {
        source: grant.source,
        sourceId: grant.source_id,
        grantId: grant.grant_id,
        title: grant.title,
        status: "succeeded" as const,
        affectedCount,
        message: stringValue(completedEntry?.result.message, "검수 완료 상태를 기록했습니다."),
      }
    })
  })

  return buildResponse(input.requestId, "mark_reviewed", results)
}

async function reconvert(
  sql: postgres.Sql,
  input: {
    requestId: string
    adminUserId: string
    grants: GrantActionRow[]
  },
): Promise<PipelineActionResponse> {
  const client = createConversionClientFromEnv()
  if (!client) {
    throw new PipelineActionError(
      "conversion_service_unavailable",
      "변환 서버 연결 환경변수가 없어 재변환을 요청할 수 없습니다.",
      503,
    )
  }

  const preparation = await sql.begin(async (tx) => {
    const insertedGrantIds = await insertQueuedAudits(tx, { ...input, action: "reconvert" })
    if (insertedGrantIds.size === 0) {
      const auditRows = await loadExistingAuditRows(tx, input.requestId, "reconvert")
      if (
        auditRows.length === input.grants.length
        && auditRows.every((row) => row.status !== "queued")
      ) {
        return { cachedResults: auditRows.map(auditRowToResult) }
      }
      throw new PipelineActionError(
        "pipeline_action_in_progress",
        "같은 요청이 이미 처리 중입니다.",
        409,
      )
    }
    if (insertedGrantIds.size !== input.grants.length) {
      throw new PipelineActionError(
        "pipeline_request_id_reused",
        "같은 requestId를 다른 공고 대상에 다시 사용할 수 없습니다.",
        409,
      )
    }
    const attachments = await loadReconvertAttachments(tx, input.grants.map((grant) => grant.grant_id))
    const requestedAttachmentsByGrant = new Map(
      input.grants.map((grant) => [grant.grant_id, grant.attachment_ids]),
    )
    const selected = attachments.filter((attachment) => {
      const requestedIds = requestedAttachmentsByGrant.get(attachment.grant_id)
      return requestedIds === null || requestedIds?.includes(attachment.attachment_id)
    })
    const eligible = attachments.filter((attachment) => {
      const requestedIds = requestedAttachmentsByGrant.get(attachment.grant_id)
      return (
        (requestedIds === null || requestedIds?.includes(attachment.attachment_id))
        && Boolean(attachment.sha256)
        && Boolean(attachment.storage_key || attachment.archive_url || attachment.source_uri)
        && conversionFormat(attachment.filename) !== null
      )
    })
    if (eligible.length > MAX_RECONVERT_ATTACHMENTS) {
      throw new PipelineActionError(
        "too_many_reconvert_attachments",
        `한 번에 재변환할 수 있는 첨부는 ${MAX_RECONVERT_ATTACHMENTS}개입니다.`,
        400,
      )
    }

    const items: PreparedConversion[] = []
    for (const attachment of eligible) {
      const surfaceId = attachment.surface_id
        ?? await ensurePendingSurface(tx, attachment)
      items.push({
        grantId: attachment.grant_id,
        source: attachment.source,
        sourceId: attachment.source_id,
        attachmentId: attachment.attachment_id,
        filename: attachment.filename,
        storageKey: attachment.storage_key,
        archiveUrl: attachment.archive_url,
        sourceUri: attachment.source_uri,
        sha256: attachment.sha256 as string,
        surfaceId,
      })
    }
    return {
      cachedResults: null,
      items,
      selectedCounts: new Map(input.grants.map((grant) => [
        grant.grant_id,
        grant.attachment_ids?.length
          ?? selected.filter((attachment) => attachment.grant_id === grant.grant_id).length,
      ])),
    }
  })
  if (preparation.cachedResults) {
    return buildResponse(input.requestId, "reconvert", preparation.cachedResults)
  }

  const storage = createRegistryStorageFromEnv()
  const settled = await Promise.all(preparation.items.map(async (item) => {
    const jobId = `${input.requestId}:${item.attachmentId}`
    try {
      let sourceObjectUrl = item.archiveUrl || item.sourceUri
      if (storage && item.storageKey) {
        sourceObjectUrl = await storage.presignGet(item.storageKey)
      }
      if (!sourceObjectUrl) throw new Error("아카이브 URL이 없습니다.")
      const response = await client.enqueue({
        jobId,
        source: item.source,
        sourceId: item.sourceId,
        surfaceId: item.surfaceId,
        filename: item.filename,
        sourceObjectUrl,
        sha256: item.sha256,
        requestedArtifacts: [...CONVERSION_REQUESTED_ARTIFACTS],
      })
      return { item, ok: true as const, response }
    } catch (error) {
      return {
        item,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))

  const results = input.grants.map((grant): PipelineActionTargetResult => {
    const targetResults = settled.filter((entry) => entry.item.grantId === grant.grant_id)
    const succeeded = targetResults.filter((entry) => entry.ok)
    const failed = targetResults.filter((entry) => !entry.ok)
    const skipped = (preparation.selectedCounts.get(grant.grant_id) ?? 0) - targetResults.length
    const status = succeeded.length === 0
      ? "failed"
      : failed.length > 0 || skipped > 0
        ? "partial"
        : "succeeded"
    const message = targetResults.length === 0
      ? "재변환 가능한 아카이브 첨부가 없습니다."
      : failed.length > 0 || skipped > 0
        ? `${succeeded.length}건 요청, ${failed.length}건 실패, ${skipped}건 제외`
        : `${succeeded.length}건의 재변환을 요청했습니다.`
    return {
      source: grant.source,
      sourceId: grant.source_id,
      grantId: grant.grant_id,
      title: grant.title,
      status,
      affectedCount: succeeded.length,
      message,
    }
  })

  await sql.begin(async (tx) => {
    for (const entry of settled) {
      await tx`
        update grant_application_surfaces
        set
          extraction_status = 'pending',
          extraction_version = ${CONVERSION_VERSION},
          updated_at = now()
        where id = ${entry.item.surfaceId}::uuid
      `
    }
    await completeAudits(tx, input.requestId, "reconvert", results.map((result) => ({
      grant_id: result.grantId,
      status: result.status,
      result: {
        affectedCount: result.affectedCount,
        message: result.message,
        jobs: settled
          .filter((entry) => entry.item.grantId === result.grantId)
          .map((entry) => entry.ok
            ? {
                attachmentId: entry.item.attachmentId,
                filename: entry.item.filename,
                jobId: entry.response.jobId,
                jobStatus: entry.response.status,
                cached: entry.response.cached,
              }
            : {
                attachmentId: entry.item.attachmentId,
                filename: entry.item.filename,
                error: entry.error,
              }),
      },
      error: result.status === "failed" ? result.message : null,
    })))
  })

  return buildResponse(input.requestId, "reconvert", results)
}

async function insertQueuedAudits(
  sql: QuerySql,
  input: {
    requestId: string
    adminUserId: string
    grants: GrantActionRow[]
    action: PipelineAction
  },
): Promise<Set<string>> {
  const values = input.grants.map((grant) => ({
    grant_id: grant.grant_id,
    source: grant.source,
    source_id: grant.source_id,
    grant_title: grant.title,
  }))
  const rows = await sql<{ grant_id: string }[]>`
    insert into admin_pipeline_actions (
      request_id,
      admin_user_id,
      grant_id,
      source,
      source_id,
      grant_title,
      action,
      status
    )
    select
      ${input.requestId}::uuid,
      ${input.adminUserId}::uuid,
      item.grant_id::uuid,
      item.source::grant_source,
      item.source_id,
      item.grant_title,
      ${input.action}::text,
      'queued'
    from jsonb_to_recordset(${sql.json(values)}::jsonb)
      as item(grant_id text, source text, source_id text, grant_title text)
    on conflict (request_id, grant_id, action) do nothing
    returning grant_id
  `
  return new Set(rows.map((row) => row.grant_id))
}

async function loadReconvertAttachments(
  sql: QuerySql,
  grantIds: string[],
): Promise<ReconvertAttachmentRow[]> {
  return sql<ReconvertAttachmentRow[]>`
    select
      g.id as grant_id,
      g.source::text as source,
      g.source_id,
      a.id as attachment_id,
      a.filename,
      a.storage_key,
      a.archive_url,
      a.source_uri,
      a.sha256,
      surface.id as surface_id
    from grants g
    join grant_attachment_archives a
      on a.source = g.source
      and a.source_id = g.source_id
    left join lateral (
      select s.id
      from grant_application_surfaces s
      where s.grant_id = g.id
        and s.type = 'file_template'
        and (
          s.source_attachment = a.storage_key
          or s.title = a.filename
        )
      order by s.updated_at desc, s.id
      limit 1
    ) surface on true
    where g.id in ${sql(grantIds)}
    order by g.id, a.filename, a.id
  `
}

async function ensurePendingSurface(
  sql: QuerySql,
  attachment: ReconvertAttachmentRow,
): Promise<string> {
  const format = conversionFormat(attachment.filename)
  if (!format) {
    throw new PipelineActionError("unsupported_conversion_format", "변환할 수 없는 첨부 형식입니다.", 400)
  }
  const rows = await sql<{ id: string }[]>`
    insert into grant_application_surfaces (
      grant_id,
      source,
      source_id,
      type,
      title,
      format,
      source_url,
      source_attachment,
      extraction_status,
      extraction_version,
      updated_at
    )
    values (
      ${attachment.grant_id}::uuid,
      ${attachment.source}::grant_source,
      ${attachment.source_id},
      'file_template',
      ${attachment.filename},
      ${format},
      ${attachment.archive_url || attachment.source_uri || null},
      ${attachment.storage_key || attachment.filename},
      'pending',
      ${CONVERSION_VERSION},
      now()
    )
    returning id
  `
  const id = rows[0]?.id
  if (!id) {
    throw new PipelineActionError("pipeline_surface_create_failed", "변환 surface를 만들지 못했습니다.", 500)
  }
  return id
}

async function completeAudits(
  sql: QuerySql,
  requestId: string,
  action: PipelineAction,
  entries: Array<{
    grant_id: string
    status: "succeeded" | "partial" | "failed"
    result: Record<string, unknown>
    error: string | null
  }>,
): Promise<void> {
  await sql`
    update admin_pipeline_actions action_log
    set
      status = item.status,
      result = item.result,
      error = item.error,
      completed_at = now()
    from jsonb_to_recordset(${sql.json(entries as unknown as postgres.JSONValue)}::jsonb)
      as item(grant_id text, status text, result jsonb, error text)
    where action_log.request_id = ${requestId}::uuid
      and action_log.action = ${action}
      and action_log.grant_id = item.grant_id::uuid
  `
}

function createConversionClientFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enqueue: (request: Record<string, unknown>) => Promise<ConversionEnqueueResponse>
} | null {
  const baseUrl = env.CONVERSION_SERVER_URL?.trim().replace(/\/+$/, "")
  const secret = env.CONVERSION_SHARED_SECRET?.trim()
  if (!baseUrl || !secret) return null
  const timeoutMs = boundedTimeout(env.CONVERSION_CLIENT_TIMEOUT_MS)
  return {
    async enqueue(request) {
      const response = await fetch(`${baseUrl}/v1/conversion-jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shared-secret": secret,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { error: text }
      }
      if (response.status !== 200 && response.status !== 202) {
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : response.statusText
        throw new Error(`변환 서버 HTTP ${response.status}: ${message}`)
      }
      return body as ConversionEnqueueResponse
    },
  }
}

function auditRowToResult(row: AuditRow): PipelineActionTargetResult {
  return {
    source: row.source,
    sourceId: row.source_id,
    grantId: row.grant_id,
    title: row.grant_title,
    status: row.status === "queued" ? "failed" : row.status,
    affectedCount: numberValue(row.result.affectedCount),
    message: stringValue(row.result.message, row.error ?? "액션 처리 결과가 없습니다."),
  }
}

function buildResponse(
  requestId: string,
  action: PipelineAction,
  results: PipelineActionTargetResult[],
): PipelineActionResponse {
  return {
    requestId,
    action,
    totals: {
      requested: results.length,
      succeeded: results.filter((result) => result.status === "succeeded").length,
      partial: results.filter((result) => result.status === "partial").length,
      failed: results.filter((result) => result.status === "failed").length,
      affected: results.reduce((total, result) => total + result.affectedCount, 0),
    },
    results,
  }
}

function hasSameGrantTargets(existing: AuditRow[], grants: GrantActionRow[]): boolean {
  if (existing.length !== grants.length) return false
  const requested = new Set(grants.map((grant) => grant.grant_id))
  return existing.every((row) => requested.has(row.grant_id))
}

function conversionFormat(filename: string): "hwp" | "hwpx" | "pdf" | "docx" | null {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  const extension = match?.[1]
  return extension === "hwp" || extension === "hwpx" || extension === "pdf" || extension === "docx"
    ? extension
    : null
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function boundedTimeout(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000 ? parsed : 30_000
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback
}
