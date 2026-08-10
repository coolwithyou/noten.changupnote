import { headers } from "next/headers"
import { redirect } from "next/navigation"

import {
  hostnameFromHostHeader,
  isLocalAdminRuntime,
} from "@/components/app-sidebar-environment"
import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { SubscriptionAgentPageView } from "@/features/subscription-agent/SubscriptionAgentPageView"
import {
  SUBSCRIPTION_AGENT_ROLES,
  defaultAdminPath,
} from "@/lib/auth/routeAccess"
import { getSubscriptionAgentOpsSnapshot } from "@/lib/server/admin/subscriptionAgentOps"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function SubscriptionAgentPage() {
  const [session, requestHeaders] = await Promise.all([
    getOptionalAdminSession(),
    headers(),
  ])
  if (!session) redirect("/login")
  if (!SUBSCRIPTION_AGENT_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  const host = hostnameFromHostHeader(
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
  )
  const localAvailable = isLocalAdminRuntime(host, process.env.NODE_ENV)
  const snapshot = await getSubscriptionAgentOpsSnapshot({ localAvailable })

  return (
    <OpsDashboardShell
      title="구독 분석 에이전트"
      user={{
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      }}
    >
      <SubscriptionAgentPageView initialSnapshot={snapshot} />
    </OpsDashboardShell>
  )
}
