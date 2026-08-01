import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import {
  buildNoticeCalendarRange,
  parseNoticeCalendarMonth,
} from "@/features/notice-calendar/calendar"
import { NoticeCalendarView } from "@/features/notice-calendar/NoticeCalendarView"
import { canAccessAdminPath, defaultAdminPath } from "@/lib/auth/routeAccess"
import { getNoticeCalendarSnapshot } from "@/lib/server/admin/noticeCalendar"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function NoticeCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [session, params] = await Promise.all([
    getOptionalAdminSession(),
    searchParams,
  ])
  if (!session) redirect("/login")
  if (!canAccessAdminPath(session.user.role, "/notice-calendar")) {
    redirect(defaultAdminPath(session.user.role))
  }

  const month = parseNoticeCalendarMonth(params.month)
  const range = buildNoticeCalendarRange(month)
  const snapshot = await getNoticeCalendarSnapshot(range)

  return (
    <OpsDashboardShell
      title="공고 처리 캘린더"
      user={{
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      }}
    >
      <NoticeCalendarView snapshot={snapshot} />
    </OpsDashboardShell>
  )
}
