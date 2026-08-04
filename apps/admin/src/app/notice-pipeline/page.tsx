import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { PipelinePageView } from "@/features/pipeline/PipelinePageView"
import {
  NOTICE_PIPELINE_ROLES,
  defaultAdminPath,
} from "@/lib/auth/routeAccess"
import {
  getPipelineNotices,
  getPipelineSummary,
  parsePipelineQuery,
} from "@/lib/server/admin/noticePipelineGraph"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface NoticePipelinePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function NoticePipelinePage({
  searchParams,
}: NoticePipelinePageProps) {
  const [session, rawSearchParams] = await Promise.all([
    getOptionalAdminSession(),
    searchParams,
  ])
  if (!session) redirect("/login")
  if (!NOTICE_PIPELINE_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  const urlSearchParams = toUrlSearchParams(rawSearchParams)
  const query = parsePipelineQuery(urlSearchParams)
  const [summary, notices] = await Promise.all([
    getPipelineSummary(query),
    getPipelineNotices(query),
  ])
  if (query.page > notices.pageCount) {
    if (notices.pageCount === 1) urlSearchParams.delete("page")
    else urlSearchParams.set("page", String(notices.pageCount))
    const normalizedQuery = urlSearchParams.toString()
    redirect(normalizedQuery
      ? `/notice-pipeline?${normalizedQuery}`
      : "/notice-pipeline")
  }

  return (
    <OpsDashboardShell
      title="수집·가공 관제"
      user={{
        email: session.user.email,
        name: session.user.name ?? null,
        role: session.user.role,
      }}
    >
      <PipelinePageView
        canMutate={session.user.role === "admin" || session.user.role === "owner"}
        canViewDeepAnalysis={session.user.role === "admin" || session.user.role === "owner"}
        canReconvert={Boolean(
          process.env.CONVERSION_SERVER_URL?.trim()
          && process.env.CONVERSION_SHARED_SECRET?.trim(),
        )}
        initialNotices={notices}
        initialSummary={summary}
        query={query}
      />
    </OpsDashboardShell>
  )
}

function toUrlSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const result = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      result.set(key, value)
    } else if (value?.[0]) {
      result.set(key, value[0])
    }
  }
  return result
}
