import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { LegacyQuestionMigrationReviewEditor } from "@/components/review/LegacyQuestionMigrationReviewEditor"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"

export default async function LegacyQuestionMigrationReviewPage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  return (
    <OpsDashboardShell
      title="레거시 질문 이관"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <section className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">레거시 질문 사람 검수</h2>
          <p className="text-sm text-muted-foreground">
            원문 조건, 기존 질문, 평가 극성, 답변 재사용 범위를 한 건씩 확정합니다.
          </p>
        </section>
        <LegacyQuestionMigrationReviewEditor actorEmail={session.user.email} />
      </main>
    </OpsDashboardShell>
  )
}
