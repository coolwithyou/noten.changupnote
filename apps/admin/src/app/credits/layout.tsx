import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export default async function CreditsLayout({ children }: { children: ReactNode }) {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")

  return (
    <OpsDashboardShell
      title="크레딧 관리"
      user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }}
    >
      {children}
    </OpsDashboardShell>
  )
}
