import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { AdjudicationWorkspace } from "@/components/review/AdjudicationWorkspace"
import { REVIEW_ADJUDICATION_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"
import { listAdjudicationItems } from "@/lib/server/review/dispatchReview"

export const dynamic = "force-dynamic"

export default async function ReviewAdjudicationPage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_ADJUDICATION_ROLES.includes(session.user.role)) redirect(defaultAdminPath(session.user.role))
  const items = await listAdjudicationItems()

  return (
    <OpsDashboardShell
      title="검수 3심"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <section className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">중복 표본 충돌 판정</h2>
          <p className="text-sm text-muted-foreground">두 검수자의 독립 판정과 사유를 비교해 최종 판정을 남깁니다.</p>
        </section>
        <AdjudicationWorkspace initialItems={items} />
      </main>
    </OpsDashboardShell>
  )
}
