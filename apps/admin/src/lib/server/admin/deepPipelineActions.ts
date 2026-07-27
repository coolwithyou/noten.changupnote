import { createHash } from "node:crypto"
import type postgres from "postgres"

import {
  type DeepPipelineActionRequest,
  type DeepPipelineActionResult,
  isDeepPipelineAction,
} from "@/features/pipeline/contract"
import type { AdminSession } from "@/lib/server/auth/adminSession"
import { getAdminSql } from "@/lib/server/db/client"

interface ExistingActionRow {
  request_id: string
  action: DeepPipelineActionRequest["action"]
  outcome: "succeeded" | "failed"
  grant_id: string
  job_id: string | null
  run_id: string | null
  exception_key: string | null
  detail: Record<string, unknown>
  error: string | null
}

interface JobRow {
  id: string
  grant_id: string
  status: string
}

interface ExceptionRow {
  id: string
  run_id: string
  exception_key: string
  event_type: string
  detail: Record<string, unknown>
}

interface AggregateSplitCaseRow {
  id: string
  grant_id: string
  status: string
  source_revision_sha256: string
  input_chars: number
  input_cap_chars: number
  cost_cap_usd: number
  approval_request_id: string | null
  latest_job_source_revision_sha256: string | null
}

export class DeepPipelineActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message)
    this.name = "DeepPipelineActionError"
  }
}

export function parseDeepPipelineActionRequest(value: unknown): DeepPipelineActionRequest {
  if (!value || typeof value !== "object") {
    throw new DeepPipelineActionError(
      "deep_pipeline_action_invalid",
      "요청 본문이 올바르지 않습니다.",
      400,
    )
  }
  const input = value as Record<string, unknown>
  if (!isUuid(input.requestId)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_request_id_invalid",
      "requestId는 UUID여야 합니다.",
      400,
      "requestId",
    )
  }
  if (!isDeepPipelineAction(input.action)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_action_invalid",
      "허용되지 않은 관제 액션입니다.",
      400,
      "action",
    )
  }
  if (!isUuid(input.grantId)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_grant_id_invalid",
      "grantId는 UUID여야 합니다.",
      400,
      "grantId",
    )
  }
  const parsed: DeepPipelineActionRequest = {
    requestId: input.requestId,
    action: input.action,
    grantId: input.grantId,
  }
  if (typeof input.jobId === "string") parsed.jobId = input.jobId
  if (typeof input.runId === "string") parsed.runId = input.runId
  if (typeof input.exceptionKey === "string") parsed.exceptionKey = input.exceptionKey
  if (typeof input.aggregateSplitCaseId === "string") {
    parsed.aggregateSplitCaseId = input.aggregateSplitCaseId
  }
  if (parsed.jobId && !isUuid(parsed.jobId)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_job_id_invalid",
      "jobId는 UUID여야 합니다.",
      400,
      "jobId",
    )
  }
  if (parsed.runId && !isUuid(parsed.runId)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_run_id_invalid",
      "runId는 UUID여야 합니다.",
      400,
      "runId",
    )
  }
  if (parsed.exceptionKey && parsed.exceptionKey.length > 200) {
    throw new DeepPipelineActionError(
      "deep_pipeline_exception_key_invalid",
      "exceptionKey가 너무 깁니다.",
      400,
      "exceptionKey",
    )
  }
  if (parsed.aggregateSplitCaseId && !isUuid(parsed.aggregateSplitCaseId)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_aggregate_split_case_id_invalid",
      "aggregateSplitCaseId는 UUID여야 합니다.",
      400,
      "aggregateSplitCaseId",
    )
  }
  return parsed
}

export async function executeDeepPipelineAction(
  session: AdminSession,
  request: DeepPipelineActionRequest,
): Promise<DeepPipelineActionResult> {
  enforceCapability(session, request)
  const sql = getAdminSql()
  const existing = await loadExistingAction(request.requestId)
  if (existing) return existingToResult(existing)

  try {
    return await sql.begin(async (transaction) => {
      const transactionExisting = await transaction<ExistingActionRow[]>`
        select request_id, action, outcome, grant_id, job_id, run_id, exception_key, detail, error
        from admin_deep_analysis_actions
        where request_id = ${request.requestId}::uuid
      `
      if (transactionExisting[0]) return existingToResult(transactionExisting[0])

      if (request.action === "requeue_job") {
        if (!request.jobId) {
          throw new DeepPipelineActionError(
            "deep_pipeline_job_required",
            "재처리할 jobId가 필요합니다.",
            400,
            "jobId",
          )
        }
        const jobs = await transaction<JobRow[]>`
          select id, grant_id, status
          from grant_deep_analysis_jobs
          where id = ${request.jobId}::uuid
          for update
        `
        const job = jobs[0]
        if (!job || job.grant_id !== request.grantId) {
          throw new DeepPipelineActionError(
            "deep_pipeline_job_not_found",
            "이 공고의 딥분석 작업을 찾을 수 없습니다.",
            404,
          )
        }
        if (!["blocked", "dead_letter", "retry_wait", "pending_budget"].includes(job.status)) {
          throw new DeepPipelineActionError(
            "deep_pipeline_job_not_requeueable",
            `현재 ${job.status} 상태의 작업은 재처리할 수 없습니다.`,
            409,
          )
        }
        await transaction`
          update grant_deep_analysis_jobs
          set
            status = 'pending',
            attempt_count = 0,
            available_at = now(),
            leased_at = null,
            lease_expires_at = null,
            worker_id = null,
            last_error_code = null,
            last_error_message = null,
            updated_at = now()
          where id = ${job.id}::uuid
        `
        await insertAction(transaction, session, request, {
          previousStatus: job.status,
          nextStatus: "pending",
        })
      } else if (request.action === "approve_aggregate_split") {
        await approveAggregateSplit(transaction, session, request)
      } else {
        await mutateException(transaction, session, request)
      }

      return {
        requestId: request.requestId,
        action: request.action,
        outcome: "succeeded",
        grantId: request.grantId,
        jobId: request.jobId ?? null,
        runId: request.runId ?? null,
        exceptionKey: request.exceptionKey ?? null,
        aggregateSplitCaseId: request.aggregateSplitCaseId ?? null,
      }
    })
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      const concurrent = await loadExistingAction(request.requestId)
      if (concurrent) return existingToResult(concurrent)
    }
    await recordFailedAction(session, request, error)
    throw error
  }
}

async function approveAggregateSplit(
  transaction: postgres.TransactionSql,
  session: AdminSession,
  request: DeepPipelineActionRequest,
): Promise<void> {
  if (!request.aggregateSplitCaseId) {
    throw new DeepPipelineActionError(
      "deep_pipeline_aggregate_split_case_required",
      "승인할 통합공고 분리 케이스가 필요합니다.",
      400,
      "aggregateSplitCaseId",
    )
  }
  const rows = await transaction<AggregateSplitCaseRow[]>`
    select
      split_case.id,
      split_case.grant_id,
      split_case.status,
      split_case.source_revision_sha256,
      split_case.input_chars,
      split_case.input_cap_chars,
      split_case.cost_cap_usd,
      split_case.approval_request_id,
      (
        select job.source_revision_sha256
        from grant_deep_analysis_jobs job
        where job.grant_id = split_case.grant_id
        order by job.created_at desc, job.id desc
        limit 1
      ) as latest_job_source_revision_sha256
    from grant_aggregate_split_cases split_case
    where split_case.id = ${request.aggregateSplitCaseId}::uuid
    for update
  `
  const splitCase = rows[0]
  if (!splitCase || splitCase.grant_id !== request.grantId) {
    throw new DeepPipelineActionError(
      "deep_pipeline_aggregate_split_case_not_found",
      "이 공고의 통합공고 분리 케이스를 찾을 수 없습니다.",
      404,
    )
  }
  if (splitCase.status !== "pending_review") {
    if (
      splitCase.status === "approved"
      && splitCase.approval_request_id === request.requestId
    ) {
      return
    }
    throw new DeepPipelineActionError(
      "deep_pipeline_aggregate_split_case_not_approvable",
      `현재 ${splitCase.status} 상태의 분리 케이스는 승인할 수 없습니다.`,
      409,
    )
  }
  if (
    splitCase.latest_job_source_revision_sha256
    && splitCase.latest_job_source_revision_sha256 !== splitCase.source_revision_sha256
  ) {
    throw new DeepPipelineActionError(
      "deep_pipeline_aggregate_split_case_stale",
      "원문이 바뀐 이전 분리 케이스입니다. 최신 입력으로 다시 감지한 뒤 승인해야 합니다.",
      409,
    )
  }

  const approvedAt = new Date()
  const detail = {
    aggregateSplitCaseId: splitCase.id,
    previousStatus: splitCase.status,
    nextStatus: "approved",
    sourceRevisionSha256: splitCase.source_revision_sha256,
    inputChars: Number(splitCase.input_chars),
    inputCapChars: Number(splitCase.input_cap_chars),
    costCapUsd: Number(splitCase.cost_cap_usd),
  }
  await transaction`
    update grant_aggregate_split_cases
    set
      status = 'approved',
      approval_request_id = ${request.requestId}::uuid,
      approved_by_admin_user_id = ${session.user.id}::uuid,
      approved_at = ${approvedAt},
      updated_at = ${approvedAt}
    where id = ${splitCase.id}::uuid
  `
  await insertAction(transaction, session, request, detail)
}

async function mutateException(
  transaction: postgres.TransactionSql,
  session: AdminSession,
  request: DeepPipelineActionRequest,
): Promise<void> {
  if (!request.runId || !request.exceptionKey) {
    throw new DeepPipelineActionError(
      "deep_pipeline_exception_target_required",
      "예외 배정에는 runId와 exceptionKey가 필요합니다.",
      400,
    )
  }
  const rows = await transaction<ExceptionRow[]>`
    select event.id, event.run_id, event.exception_key, event.event_type, event.detail
    from grant_deep_analysis_exception_events event
    join grant_deep_analysis_runs run on run.id = event.run_id
    where event.run_id = ${request.runId}::uuid
      and event.exception_key = ${request.exceptionKey}
      and run.grant_id = ${request.grantId}::uuid
    order by event.created_at desc, event.id desc
    limit 1
    for update of event
  `
  const current = rows[0]
  if (!current) {
    throw new DeepPipelineActionError(
      "deep_pipeline_exception_not_found",
      "이 공고의 현재 예외를 찾을 수 없습니다.",
      404,
    )
  }

  if (request.action === "claim_exception") {
    if (current.event_type === "resolved") {
      throw new DeepPipelineActionError(
        "deep_pipeline_exception_resolved",
        "이미 해결된 예외는 배정할 수 없습니다.",
        409,
      )
    }
    if (current.event_type === "assigned") {
      throw new DeepPipelineActionError(
        "deep_pipeline_exception_already_assigned",
        "이미 다른 요청으로 배정된 예외입니다.",
        409,
      )
    }
    const detail = {
      assigneeAdminUserId: session.user.id,
      assigneeEmail: session.user.email,
      previousEventId: current.id,
    }
    await insertExceptionEvent(transaction, session, request, "assigned", detail)
    await insertAction(transaction, session, request, detail)
    return
  }

  if (request.action !== "release_exception") {
    throw new DeepPipelineActionError(
      "deep_pipeline_action_invalid",
      "예외에 적용할 수 없는 액션입니다.",
      400,
    )
  }
  if (current.event_type !== "assigned") {
    throw new DeepPipelineActionError(
      "deep_pipeline_exception_not_assigned",
      "현재 배정 상태인 예외만 해제할 수 있습니다.",
      409,
    )
  }
  const assigneeId = typeof current.detail.assigneeAdminUserId === "string"
    ? current.detail.assigneeAdminUserId
    : null
  const elevated = session.user.role === "admin" || session.user.role === "owner"
  if (!elevated && assigneeId !== session.user.id) {
    throw new DeepPipelineActionError(
      "deep_pipeline_exception_not_assignee",
      "본인에게 배정된 예외만 해제할 수 있습니다.",
      403,
    )
  }
  const detail = {
    releasedAssigneeAdminUserId: assigneeId,
    releasedByAdminUserId: session.user.id,
    previousEventId: current.id,
  }
  await insertExceptionEvent(transaction, session, request, "released", detail)
  await insertAction(transaction, session, request, detail)
}

async function insertExceptionEvent(
  transaction: postgres.TransactionSql,
  session: AdminSession,
  request: DeepPipelineActionRequest,
  eventType: "assigned" | "released",
  detail: Record<string, unknown>,
): Promise<void> {
  const evidence = {
    schema: "deep-analysis-exception-ops-v1",
    requestId: request.requestId,
    grantId: request.grantId,
    runId: request.runId,
    exceptionKey: request.exceptionKey,
    eventType,
    actor: session.user.email,
    detail,
  }
  await transaction`
    insert into grant_deep_analysis_exception_events (
      run_id,
      exception_key,
      event_type,
      reason_code,
      actor_type,
      actor,
      detail,
      evidence_sha256
    ) values (
      ${request.runId!}::uuid,
      ${request.exceptionKey!},
      ${eventType},
      ${eventType === "assigned" ? "ops_exception_claimed" : "ops_exception_released"},
      'human',
      ${session.user.email},
      ${transaction.json(detail as postgres.JSONValue)},
      ${sha256(stableJson(evidence))}
    )
  `
}

async function insertAction(
  transaction: postgres.TransactionSql,
  session: AdminSession,
  request: DeepPipelineActionRequest,
  detail: Record<string, unknown>,
): Promise<void> {
  await transaction`
    insert into admin_deep_analysis_actions (
      request_id,
      admin_user_id,
      grant_id,
      run_id,
      job_id,
      exception_key,
      action,
      outcome,
      detail
    ) values (
      ${request.requestId}::uuid,
      ${session.user.id}::uuid,
      ${request.grantId}::uuid,
      ${request.runId ?? null}::uuid,
      ${request.jobId ?? null}::uuid,
      ${request.exceptionKey ?? null},
      ${request.action},
      'succeeded',
      ${transaction.json(detail as postgres.JSONValue)}
    )
  `
}

async function recordFailedAction(
  session: AdminSession,
  request: DeepPipelineActionRequest,
  error: unknown,
): Promise<void> {
  const sql = getAdminSql()
  try {
    await sql`
      insert into admin_deep_analysis_actions (
        request_id,
        admin_user_id,
        grant_id,
        run_id,
        job_id,
        exception_key,
        action,
        outcome,
        detail,
        error
      ) values (
        ${request.requestId}::uuid,
        ${session.user.id}::uuid,
        ${request.grantId}::uuid,
        ${request.runId ?? null}::uuid,
        ${request.jobId ?? null}::uuid,
        ${request.exceptionKey ?? null},
        ${request.action},
        'failed',
        ${sql.json({
          ...(request.aggregateSplitCaseId
            ? { aggregateSplitCaseId: request.aggregateSplitCaseId }
            : {}),
        })},
        ${error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)}
      )
      on conflict (request_id) do nothing
    `
  } catch {
    // 잘못된 FK 등으로 실패 감사 자체가 불가능해도 원래 오류를 바꾸지 않는다.
  }
}

async function loadExistingAction(requestId: string): Promise<ExistingActionRow | null> {
  const sql = getAdminSql()
  const rows = await sql<ExistingActionRow[]>`
    select request_id, action, outcome, grant_id, job_id, run_id, exception_key, detail, error
    from admin_deep_analysis_actions
    where request_id = ${requestId}::uuid
  `
  return rows[0] ?? null
}

function existingToResult(row: ExistingActionRow): DeepPipelineActionResult {
  if (row.outcome === "failed") {
    throw new DeepPipelineActionError(
      "deep_pipeline_action_previously_failed",
      row.error ?? "같은 requestId의 이전 요청이 실패했습니다.",
      409,
    )
  }
  return {
    requestId: row.request_id,
    action: row.action,
    outcome: "succeeded",
    grantId: row.grant_id,
    jobId: row.job_id,
    runId: row.run_id,
    exceptionKey: row.exception_key,
    aggregateSplitCaseId: typeof row.detail.aggregateSplitCaseId === "string"
      ? row.detail.aggregateSplitCaseId
      : null,
  }
}

function enforceCapability(
  session: AdminSession,
  request: DeepPipelineActionRequest,
): void {
  if (request.action === "requeue_job") {
    if (session.user.role !== "admin" && session.user.role !== "owner") {
      throw new DeepPipelineActionError(
        "deep_pipeline_action_forbidden",
        "딥분석 재처리는 admin 또는 owner만 실행할 수 있습니다.",
        403,
      )
    }
    return
  }
  if (request.action === "approve_aggregate_split") {
    if (session.user.role !== "admin" && session.user.role !== "owner") {
      throw new DeepPipelineActionError(
        "deep_pipeline_action_forbidden",
        "통합공고 분리 승인은 admin 또는 owner만 실행할 수 있습니다.",
        403,
      )
    }
    return
  }
  if (!["reviewer", "admin", "owner"].includes(session.user.role)) {
    throw new DeepPipelineActionError(
      "deep_pipeline_action_forbidden",
      "예외 배정 권한이 없습니다.",
      403,
    )
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "23505",
  )
}

function stableJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}`)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
