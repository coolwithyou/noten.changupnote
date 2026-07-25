import { DEEP_PIPELINE_ROLES } from "@/lib/auth/routeAccess"
import {
  DeepPipelineError,
  getDeepPipelineNoticeDetail,
} from "@/lib/server/admin/deepPipeline"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole"
import { adminData, adminError } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  context: { params: Promise<{ grantId: string }> },
) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, DEEP_PIPELINE_ROLES)
    const { grantId } = await context.params
    return adminData(await getDeepPipelineNoticeDetail(grantId))
  } catch (error) {
    return pipelineError(error, "deep_pipeline_notice_failed", "딥분석 증적을 불러오지 못했습니다.")
  }
}

function pipelineError(error: unknown, code: string, fallback: string): Response {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status)
  const roleError = handleRoleError(error)
  if (roleError) return roleError
  if (error instanceof DeepPipelineError) {
    return adminError(error.code, error.message, error.status)
  }
  return adminError(code, error instanceof Error ? error.message : fallback)
}
