import {
  PipelineGraphError,
  getPipelineNotices,
  parsePipelineQuery,
} from "@/lib/server/admin/noticePipelineGraph"
import { NOTICE_PIPELINE_ROLES } from "@/lib/auth/routeAccess"
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

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, NOTICE_PIPELINE_ROLES)
    const query = parsePipelineQuery(new URL(request.url).searchParams)
    return adminData(await getPipelineNotices(query))
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return adminError(error.code, error.message, error.status)
    }
    const roleError = handleRoleError(error)
    if (roleError) return roleError
    if (error instanceof PipelineGraphError) {
      return adminError(error.code, error.message, error.status)
    }
    return adminError(
      "admin_notice_pipeline_notices_failed",
      error instanceof Error ? error.message : "공고 관제 큐를 불러오지 못했습니다.",
    )
  }
}
