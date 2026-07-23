import { notFound, redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { ReviewNoticeWorkspace } from "@/components/review/ReviewNoticeWorkspace"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"
import {
  DispatchReviewError,
  getReviewNotice,
} from "@/lib/server/review/dispatchReview"

export const dynamic = "force-dynamic"

export default async function ReviewNoticePage({
  params,
}: {
  params: Promise<{ noticeId: string }>
}) {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) redirect(defaultAdminPath(session.user.role))
  const { noticeId } = await params
  let notice
  try {
    notice = await getReviewNotice(session, noticeId)
  } catch (error) {
    if (error instanceof DispatchReviewError && error.status === 404) notFound()
    if (error instanceof DispatchReviewError && error.status === 403) redirect("/review")
    throw error
  }

  return (
    <OpsDashboardShell
      title={notice.title}
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <ReviewNoticeWorkspace notice={notice} />
    </OpsDashboardShell>
  )
}
