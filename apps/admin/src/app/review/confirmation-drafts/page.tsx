import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { ConfirmationQuestionDraftEditor } from "@/components/review/ConfirmationQuestionDraftEditor"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"

export default async function ConfirmationQuestionDraftPage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) {
    redirect(defaultAdminPath(session.user.role))
  }

  return (
    <OpsDashboardShell
      title="확인질문 초안"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <section className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">확인질문 파일 검수</h2>
          <p className="text-sm text-muted-foreground">
            원문 기반 자동 초안을 편집하고 기존 manual CLI 입력으로 내보냅니다.
          </p>
        </section>
        <ConfirmationQuestionDraftEditor actorEmail={session.user.email} />
      </main>
    </OpsDashboardShell>
  )
}
