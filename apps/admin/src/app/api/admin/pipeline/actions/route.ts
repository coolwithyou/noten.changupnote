import { DEEP_PIPELINE_ROLES } from "@/lib/auth/routeAccess"
import {
  DeepPipelineActionError,
  executeDeepPipelineAction,
  parseDeepPipelineActionRequest,
} from "@/lib/server/admin/deepPipelineActions"
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

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, DEEP_PIPELINE_ROLES)
    const action = parseDeepPipelineActionRequest(await readJson(request))
    return adminData(await executeDeepPipelineAction(session, action))
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return adminError(error.code, error.message, error.status)
    }
    const roleError = handleRoleError(error)
    if (roleError) return roleError
    if (error instanceof DeepPipelineActionError) {
      return adminError(error.code, error.message, error.status, error.field)
    }
    return adminError(
      "deep_pipeline_action_failed",
      error instanceof Error ? error.message : "딥분석 관제 액션에 실패했습니다.",
    )
  }
}
