import {
  executePipelineAction,
  parsePipelineActionRequest,
  PipelineActionError,
} from "@/lib/server/admin/pipelineActions"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole"
import { adminData, adminError, readJson } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession()
    requireAdminRole(admin, "admin")
    const action = parsePipelineActionRequest(await readJson(request))
    return adminData(await executePipelineAction({
      request: action,
      adminUserId: admin.user.id,
    }))
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return adminError(error.code, error.message, error.status)
    }
    const roleError = handleRoleError(error)
    if (roleError) return roleError
    if (error instanceof PipelineActionError) {
      return adminError(error.code, error.message, error.status)
    }
    return adminError(
      "admin_pipeline_action_failed",
      error instanceof Error ? error.message : "공고 관제 액션을 처리하지 못했습니다.",
    )
  }
}
