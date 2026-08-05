import { DEEP_PIPELINE_ROLES } from "@/lib/auth/routeAccess"
import {
  DeepAnalysisRuntimeAdminError,
  getDeepAnalysisRuntimeControlStatus,
  setProductionDeepAnalysisMode,
} from "@/lib/server/admin/deepAnalysisRuntimeControl"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole"
import { adminData, adminError, readJson } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, DEEP_PIPELINE_ROLES)
    return adminData(await getDeepAnalysisRuntimeControlStatus())
  } catch (error) {
    return runtimeControlError(error)
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, ["admin", "owner"])
    const body = await readJson(request) as { mode?: unknown; reason?: unknown }
    if (body.mode !== "paused" && body.mode !== "production_api") {
      return adminError(
        "invalid_runtime_mode",
        "mode는 paused 또는 production_api여야 합니다.",
        400,
        "mode",
      )
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return adminError("invalid_reason", "reason은 문자열이어야 합니다.", 400, "reason")
    }
    return adminData(await setProductionDeepAnalysisMode({
      mode: body.mode,
      changedBy: `${session.user.email} (${session.user.id})`,
      reason: body.reason?.trim() || null,
    }))
  } catch (error) {
    return runtimeControlError(error)
  }
}

function runtimeControlError(error: unknown): Response {
  if (error instanceof AdminRequiredError) {
    return adminError(error.code, error.message, error.status)
  }
  const roleError = handleRoleError(error)
  if (roleError) return roleError
  if (error instanceof DeepAnalysisRuntimeAdminError) {
    return adminError(error.code, error.message, error.status)
  }
  return adminError(
    "runtime_control_failed",
    error instanceof Error ? error.message : "딥분석 실행 모드를 처리하지 못했습니다.",
  )
}
