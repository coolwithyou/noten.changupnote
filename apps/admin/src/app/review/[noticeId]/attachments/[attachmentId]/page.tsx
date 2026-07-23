import { notFound, redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { ReviewAttachmentPreview } from "@/components/review/ReviewAttachmentPreview"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"
import {
  DispatchReviewError,
  getReviewAttachmentSource,
} from "@/lib/server/review/dispatchReview"

export const dynamic = "force-dynamic"

export default async function ReviewAttachmentPage({
  params,
}: {
  params: Promise<{ noticeId: string; attachmentId: string }>
}) {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) redirect(defaultAdminPath(session.user.role))
  const { noticeId, attachmentId } = await params
  let attachment
  try {
    attachment = await getReviewAttachmentSource(session, noticeId, attachmentId)
  } catch (error) {
    if (error instanceof DispatchReviewError && error.status === 404) notFound()
    if (error instanceof DispatchReviewError && error.status === 403) redirect("/review")
    throw error
  }

  return (
    <OpsDashboardShell
      title="첨부 문서 미리보기"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <ReviewAttachmentPreview
        noticeId={noticeId}
        attachmentId={attachment.id}
        filename={attachment.filename}
        format={attachment.format}
      />
    </OpsDashboardShell>
  )
}
