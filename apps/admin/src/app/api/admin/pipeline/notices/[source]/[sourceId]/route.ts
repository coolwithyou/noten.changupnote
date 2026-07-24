import {
  PipelineGraphError,
  getPipelineNoticeDetail,
} from "@/lib/server/admin/pipelineGraph"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import { adminData, adminError } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<unknown>
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const sessionPromise = requireAdminSession()
    const paramsPromise = context.params
    await sessionPromise
    const params = await paramsPromise
    return adminData(await getPipelineNoticeDetail({
      source: readParam(params, "source"),
      sourceId: readParam(params, "sourceId"),
    }))
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return adminError(error.code, error.message, error.status)
    }
    if (error instanceof PipelineGraphError) {
      return adminError(error.code, error.message, error.status)
    }
    return adminError(
      "admin_pipeline_notice_failed",
      error instanceof Error ? error.message : "공고 상세를 불러오지 못했습니다.",
    )
  }
}

function readParam(params: unknown, key: string): string {
  if (params && typeof params === "object" && key in params) {
    const value = (params as Record<string, unknown>)[key]
    if (typeof value === "string" && value) return value
  }
  throw new PipelineGraphError(
    "invalid_pipeline_route_param",
    "공고 상세 경로를 확인해주세요.",
    400,
  )
}
