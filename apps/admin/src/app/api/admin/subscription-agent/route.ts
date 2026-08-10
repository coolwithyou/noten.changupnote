import {
  hostnameFromHostHeader,
  isLocalAdminRuntime,
} from "@/components/app-sidebar-environment"
import { SUBSCRIPTION_AGENT_ROLES } from "@/lib/auth/routeAccess"
import {
  SubscriptionAgentOpsError,
  getSubscriptionAgentOpsSnapshot,
  planSubscriptionAgentRun,
  startSubscriptionAgentRun,
  stopSubscriptionAgentRun,
} from "@/lib/server/admin/subscriptionAgentOps"
import {
  AdminRequiredError,
  requireAdminSession,
} from "@/lib/server/auth/adminSession"
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole"
import { adminData, adminError, readJson } from "@/lib/server/http/envelope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, SUBSCRIPTION_AGENT_ROLES)
    return adminData(await getSubscriptionAgentOpsSnapshot({
      localAvailable: localAvailable(request),
    }))
  } catch (error) {
    return subscriptionAgentError(error)
  }
}
export async function POST(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, SUBSCRIPTION_AGENT_ROLES)
    const body = await readJson(request)
    const count = parseCount(body.count)
    const available = localAvailable(request)
    if (body.action === "plan") {
      return adminData(await planSubscriptionAgentRun({ count, localAvailable: available }))
    }
    if (body.action === "start") {
      return adminData(await startSubscriptionAgentRun({ count, localAvailable: available }), { status: 202 })
    }
    return adminError("invalid_agent_action", "action은 plan 또는 start여야 합니다.", 400, "action")
  } catch (error) {
    return subscriptionAgentError(error)
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireAdminSession()
    requireAnyAdminRole(session, SUBSCRIPTION_AGENT_ROLES)
    return adminData(await stopSubscriptionAgentRun({ localAvailable: localAvailable(request) }))
  } catch (error) {
    return subscriptionAgentError(error)
  }
}

function parseCount(value: unknown): 5 | 10 | 30 {
  if (value === 5 || value === 10 || value === 30) return value
  throw new SubscriptionAgentOpsError("invalid_agent_count", "count는 5, 10, 30 중 하나여야 합니다.", 400)
}

function localAvailable(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-host")
  const host = hostnameFromHostHeader(forwarded ?? request.headers.get("host"))
  return isLocalAdminRuntime(host, process.env.NODE_ENV)
}

function subscriptionAgentError(error: unknown): Response {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status)
  const roleError = handleRoleError(error)
  if (roleError) return roleError
  if (error instanceof SubscriptionAgentOpsError) {
    return adminError(error.code, error.message, error.status)
  }
  return adminError(
    "subscription_agent_failed",
    error instanceof Error ? error.message : "구독 분석 에이전트 요청을 처리하지 못했습니다.",
  )
}
