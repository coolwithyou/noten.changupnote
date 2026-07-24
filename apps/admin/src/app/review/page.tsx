import Link from "next/link"
import { redirect } from "next/navigation"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { ReviewQueueOpenLink } from "@/components/review/ReviewQueueOpenLink"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import {
  listReviewQueue,
  type ReviewQueueItem,
} from "@/lib/server/review/dispatchReview"

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
  const inProgressItems = queue.items.filter((item) => !isReviewComplete(item))
  const completedItems = queue.items.filter(isReviewComplete)
  const showAssignees = session.user.role === "admin" || session.user.role === "owner"

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
            <Progress
              value={progress}
              className="min-w-0 flex-1"
              aria-label="이번 주 검수 진행률"
            />
            <span className="shrink-0 text-sm font-medium tabular-nums">{progress}%</span>
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
            <Tabs defaultValue={inProgressItems.length > 0 ? "in-progress" : "completed"}>
              <TabsList>
                <TabsTrigger value="in-progress">진행 중 {inProgressItems.length}</TabsTrigger>
                <TabsTrigger value="completed">완료 {completedItems.length}</TabsTrigger>
              </TabsList>
              <TabsContent value="in-progress">
                <ReviewQueueTable
                  items={inProgressItems}
                  emptyMessage="진행 중인 검수 공고가 없습니다."
                  showAssignees={showAssignees}
                />
              </TabsContent>
              <TabsContent value="completed">
                <p className="pb-3 text-sm text-muted-foreground">
                  완료한 공고도 결과를 다시 열어 저장된 판정을 확인하거나 필요한 항목만 수정할 수 있습니다.
                </p>
                <ReviewQueueTable
                  items={completedItems}
                  emptyMessage="완료한 검수 공고가 없습니다."
                  showAssignees={showAssignees}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>
    </OpsDashboardShell>
  )
}

function ReviewQueueTable({
  items,
  emptyMessage,
  showAssignees,
}: {
  items: ReviewQueueItem[]
  emptyMessage: string
  showAssignees: boolean
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>공고</TableHead>
          <TableHead>출처</TableHead>
          {showAssignees ? <TableHead>검수자</TableHead> : null}
          <TableHead>진행</TableHead>
          <TableHead>상태</TableHead>
          <TableHead className="text-right">열기</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={showAssignees ? 6 : 5} className="text-center text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        ) : items.map((item) => {
          const complete = isReviewComplete(item)
          return (
            <TableRow key={item.noticeId}>
              <TableCell>
                <div className="flex max-w-xl flex-col gap-1">
                  <span className="font-medium">{item.title}</span>
                  <span className="text-xs text-muted-foreground">{item.sourceId}</span>
                </div>
              </TableCell>
              <TableCell>{item.source}</TableCell>
              {showAssignees ? (
                <TableCell>
                  <div className="flex min-w-32 flex-col gap-2">
                    {item.assignees.map((assignee) => (
                      <div key={assignee.id} className="flex flex-col">
                        <span className="text-sm font-medium">
                          {assignee.name ?? assignee.email.split("@")[0]}
                        </span>
                        <span className="text-xs text-muted-foreground">{assignee.email}</span>
                      </div>
                    ))}
                  </div>
                </TableCell>
              ) : null}
              <TableCell>{item.decidedCount}/{item.itemCount} · {item.progress}%</TableCell>
              <TableCell>
                <Badge variant={item.conflictCount > 0 ? "destructive" : "secondary"}>
                  {item.conflictCount > 0 ? `충돌 ${item.conflictCount}` : complete ? "완료" : "진행 중"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <ReviewQueueOpenLink
                  href={`/review/${item.noticeId}`}
                  label={complete ? "결과 보기·수정" : item.decidedCount > 0 ? "이어서 검수" : "검수 시작"}
                />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function isReviewComplete(item: ReviewQueueItem): boolean {
  return item.itemCount > 0 && item.decidedCount === item.itemCount
}
