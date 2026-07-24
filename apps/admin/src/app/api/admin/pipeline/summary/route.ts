import {
  PipelineGraphError,
  getPipelineSummary,
  parsePipelineQuery,
} from "@/lib/server/admin/pipelineGraph"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import { adminData, adminError } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await requireAdminSession()
    const query = parsePipelineQuery(new URL(request.url).searchParams)
    return adminData(await getPipelineSummary(query))
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return adminError(error.code, error.message, error.status)
    }
    if (error instanceof PipelineGraphError) {
      return adminError(error.code, error.message, error.status)
    }
    return adminError(
      "admin_pipeline_summary_failed",
      error instanceof Error ? error.message : "공고 관제 요약을 불러오지 못했습니다.",
    )
  }
}
