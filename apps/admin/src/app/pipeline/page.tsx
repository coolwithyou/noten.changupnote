import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { PipelinePageView } from "@/features/pipeline/PipelinePageView"
import {
  getPipelineNotices,
  getPipelineSummary,
  parsePipelineQuery,
} from "@/lib/server/admin/pipelineGraph"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PipelinePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function PipelinePage({ searchParams }: PipelinePageProps) {
  const [session, rawSearchParams] = await Promise.all([
    getOptionalAdminSession(),
    searchParams,
  ])
  if (!session) redirect("/login")

  const query = parsePipelineQuery(toUrlSearchParams(rawSearchParams))
  const [summary, notices] = await Promise.all([
    getPipelineSummary(query),
    getPipelineNotices(query),
  ])

  return (
    <OpsDashboardShell
      title="공고 관제"
      user={{
        email: session.user.email,
        name: session.user.name ?? null,
        role: session.user.role,
      }}
    >
      <PipelinePageView
        canMutate={session.user.role === "admin" || session.user.role === "owner"}
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
