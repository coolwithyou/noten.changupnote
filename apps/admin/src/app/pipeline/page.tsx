import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { AnalysisMonitoringPageView } from "@/features/analysis-monitoring/AnalysisMonitoringPageView"
import {
  DEEP_PIPELINE_ROLES,
  defaultAdminPath,
} from "@/lib/auth/routeAccess"
import { getAnalysisMonitoringSnapshot } from "@/lib/server/admin/analysisMonitoring"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function PipelinePage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!DEEP_PIPELINE_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  const snapshot = await getAnalysisMonitoringSnapshot()

  return (
    <OpsDashboardShell
      title="딥분석 시스템"
      user={{
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      }}
    >
      <AnalysisMonitoringPageView snapshot={snapshot} />
    </OpsDashboardShell>
  )
}
