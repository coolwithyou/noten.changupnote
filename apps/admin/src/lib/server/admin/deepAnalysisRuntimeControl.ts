import {
  effectiveDeepAnalysisRuntimeMode,
  parseDeepAnalysisRuntimeMode,
  type DeepAnalysisRuntimeControl,
  type DeepAnalysisRuntimeControlStatus,
} from "@cunote/contracts"
import type postgres from "postgres"

import { getAdminSql } from "@/lib/server/db/client"

type RuntimeSql = postgres.Sql | postgres.TransactionSql

interface ControlRow {
  control_key: string
  mode: string
  generation: number
  changed_by: string
  change_reason: string | null
  local_owner_id: string | null
  local_lease_expires_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface LeaseCountRow {
  active_deep_leases: number
  active_application_leases: number
}

export class DeepAnalysisRuntimeAdminError extends Error {
  constructor(
    readonly code: "runtime_control_missing",
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = "DeepAnalysisRuntimeAdminError"
  }
}

export async function getDeepAnalysisRuntimeControlStatus(
  sql: RuntimeSql = getAdminSql(),
  now: Date = new Date(),
): Promise<DeepAnalysisRuntimeControlStatus> {
  const [rows, leaseRows] = await Promise.all([
    sql<ControlRow[]>`
      SELECT
        control_key,
        mode,
        generation,
        changed_by,
        change_reason,
        local_owner_id,
        local_lease_expires_at,
        created_at,
        updated_at
      FROM deep_analysis_runtime_control
      WHERE control_key = 'global'
      LIMIT 1
    `,
    sql<LeaseCountRow[]>`
      SELECT
        (
          SELECT count(*)::int
          FROM grant_deep_analysis_jobs
          WHERE status = 'leased'
            AND lease_expires_at > now()
        ) AS active_deep_leases,
        (
          SELECT count(*)::int
          FROM grant_application_precompute_jobs
          WHERE status = 'leased'
            AND lease_expires_at > now()
        ) AS active_application_leases
    `,
  ])
  const row = rows[0]
  if (!row) {
    throw new DeepAnalysisRuntimeAdminError(
      "runtime_control_missing",
      "딥분석 실행 모드 정본이 없습니다. migration 0069를 먼저 적용하세요.",
      503,
    )
  }
  const control = serializeControl(row)
  const effectiveMode = effectiveDeepAnalysisRuntimeMode(control, now)
  return {
    ...control,
    effectiveMode,
    productionAllowed: effectiveMode === "production_api",
    localAllowed: effectiveMode === "local_subscription",
    activeDeepLeases: leaseRows[0]?.active_deep_leases ?? 0,
    activeApplicationLeases: leaseRows[0]?.active_application_leases ?? 0,
  }
}

function serializeControl(row: ControlRow): DeepAnalysisRuntimeControl {
  if (row.control_key !== "global") {
    throw new DeepAnalysisRuntimeAdminError(
      "runtime_control_missing",
      `알 수 없는 runtime control key입니다: ${row.control_key}`,
      503,
    )
  }
  return {
    controlKey: "global",
    mode: parseDeepAnalysisRuntimeMode(row.mode),
    generation: Number(row.generation),
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    localOwnerId: row.local_owner_id,
    localLeaseExpiresAt: toIso(row.local_lease_expires_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  }
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : requiredIso(value)
}

function requiredIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid runtime control timestamp: ${String(value)}`)
  return date.toISOString()
}
