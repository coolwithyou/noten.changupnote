import Link from "next/link"
import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { REVIEW_WORKSPACE_ROLES, defaultAdminPath } from "@/lib/auth/routeAccess"
import { cn } from "@/lib/utils"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"
import { listReviewQueue } from "@/lib/server/review/dispatchReview"

export const dynamic = "force-dynamic"

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  if (!REVIEW_WORKSPACE_ROLES.includes(session.user.role)) redirect(defaultAdminPath(session.user.role))
  const params = await searchParams
  const queue = await listReviewQueue(session, params.week ? { week: params.week } : {})
  const total = queue.items.reduce((sum, item) => sum + item.itemCount, 0)
  const decided = queue.items.reduce((sum, item) => sum + item.decidedCount, 0)
  const progress = total === 0 ? 0 : Math.round((decided / total) * 100)

  return (
    <OpsDashboardShell
      title="주간 검수"
      user={{ email: session.user.email, name: session.user.name, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <section className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">검수 배정 큐</h2>
              {queue.week ? <Badge variant="secondary">{queue.week}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">미판정 공고가 먼저 표시됩니다. 검수 미완은 서비스 노출을 차단하지 않습니다.</p>
          </div>
          <div className="flex gap-2">
            <Link className={cn(buttonVariants({ variant: "outline" }))} href="/review/guide">판정 가이드</Link>
            {session.user.role === "admin" || session.user.role === "owner" ? (
              <Link className={cn(buttonVariants({ variant: "outline" }))} href="/review/adjudicate">3심 대기</Link>
            ) : null}
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>이번 주 진행률</CardTitle>
            <CardDescription>{decided}/{total} 항목 판정 완료</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <Progress value={progress} />
            <span className="text-sm font-medium">{progress}%</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>공고별 배정</CardTitle>
            <CardDescription>
              {session.user.role === "reviewer" ? "본인에게 배정된 공고만 표시됩니다." : "전체 배정을 운영자 권한으로 표시합니다."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>공고</TableHead>
                  <TableHead>출처</TableHead>
                  <TableHead>진행</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead className="text-right">열기</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.items.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">배정된 검수 항목이 없습니다.</TableCell></TableRow>
                ) : queue.items.map((item) => (
                  <TableRow key={item.noticeId}>
                    <TableCell>
                      <div className="flex max-w-xl flex-col gap-1">
                        <span className="font-medium">{item.title}</span>
                        <span className="text-xs text-muted-foreground">{item.sourceId}</span>
                      </div>
                    </TableCell>
                    <TableCell>{item.source}</TableCell>
                    <TableCell>{item.decidedCount}/{item.itemCount} · {item.progress}%</TableCell>
                    <TableCell>
                      <Badge variant={item.conflictCount > 0 ? "destructive" : "secondary"}>
                        {item.conflictCount > 0 ? `충돌 ${item.conflictCount}` : item.progress === 100 ? "완료" : "진행 중"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link className={cn(buttonVariants({ size: "sm" }))} href={`/review/${item.noticeId}`}>검수하기</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </OpsDashboardShell>
  )
}
