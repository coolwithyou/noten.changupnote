import { REVIEW_WORKSPACE_ROLES } from "@/lib/auth/routeAccess"
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession"
import { handleRoleError, requireAnyAdminRole } from "@/lib/server/auth/adminRole"
import {
  DispatchReviewError,
  getReviewAttachmentSource,
} from "@/lib/server/review/dispatchReview"
import {
  attachmentContentDisposition,
  fetchReviewAttachment,
} from "@/lib/server/review/reviewAttachmentFetch"
import { adminError } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string; attachmentId: string }>
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, REVIEW_WORKSPACE_ROLES)
    const { id, attachmentId } = await context.params
    const attachment = await getReviewAttachmentSource(session, id, attachmentId)
    const file = await fetchReviewAttachment({
      source: attachment.source,
      sourceUri: attachment.sourceUri,
      expectedBytes: attachment.bytes,
    })
    const download = new URL(request.url).searchParams.get("download") === "1"
    return new Response(file.bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": attachmentContentDisposition(attachment.filename, download),
        "content-type": attachment.contentType ?? file.contentType ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status)
    const roleError = handleRoleError(error)
    if (roleError) return roleError
    if (error instanceof DispatchReviewError) {
      return adminError(error.code, error.message, error.status, error.field)
    }
    return adminError(
      "review_attachment_failed",
      error instanceof Error ? error.message : "첨부를 불러오지 못했습니다.",
    )
  }
}
