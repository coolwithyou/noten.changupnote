import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { DeepPipelinePageView } from "@/features/pipeline/DeepPipelinePageView"
import { DeepAnalysisRuntimeControlCard } from "@/features/pipeline/DeepAnalysisRuntimeControlCard"
import {
  DEEP_PIPELINE_ROLES,
  defaultAdminPath,
} from "@/lib/auth/routeAccess"
import {
  getDeepPipelineSummary,
  parseDeepPipelineQuery,
} from "@/lib/server/admin/deepPipeline"
import { getDeepAnalysisRuntimeControlStatus } from "@/lib/server/admin/deepAnalysisRuntimeControl"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [session, rawSearchParams] = await Promise.all([
    getOptionalAdminSession(),
    searchParams,
  ])
  if (!session) redirect("/login")
  if (!DEEP_PIPELINE_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  const query = parseDeepPipelineQuery(toUrlSearchParams(rawSearchParams))
  const [summary, runtimeControl] = await Promise.all([
    getDeepPipelineSummary(query),
    getDeepAnalysisRuntimeControlStatus(),
  ])

  return (
    <OpsDashboardShell
      title="딥분석 관제"
      user={{
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      }}
    >
      <DeepAnalysisRuntimeControlCard
        initialStatus={runtimeControl}
        role={session.user.role}
        workerExecutionMode={summary.worker.executionMode}
      />
      <DeepPipelinePageView
        initialSummary={summary}
        query={query}
        role={session.user.role}
      />
    </OpsDashboardShell>
  )
}

function toUrlSearchParams(
  values: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") params.set(key, value)
    else if (value?.[0]) params.set(key, value[0])
  }
  return params
}
