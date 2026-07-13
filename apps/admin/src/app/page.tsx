import Link from "next/link"
import { redirect } from "next/navigation"
import {
  ActivityIcon,
  ArrowUpRightIcon,
  CircleGaugeIcon,
  Clock3Icon,
  DatabaseZapIcon,
  HeartPulseIcon,
  LifeBuoyIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { OpsDashboardShell } from "@/components/OpsDashboardShell"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getOpsFlywheelSnapshot, type OpsFlywheelSurface } from "@/lib/server/admin/flywheel"
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession"

export const dynamic = "force-dynamic"

export default async function OpsHomePage() {
  const session = await getOptionalAdminSession()
  if (!session) redirect("/login")
  const snapshot = await loadFlywheelSnapshot()
  const surfaces = snapshot?.surfaces ?? []
  const available = surfaces.filter((surface) => surface.available)

  const metrics = [
    {
      label: "연결된 운영 데이터",
      value: snapshot ? `${available.length}/${surfaces.length}` : "-",
      description: snapshot ? `${surfaces.length - available.length}개 소스 확인 필요` : "DB 연결 확인 필요",
      icon: DatabaseZapIcon,
      href: "/registry-imports",
    },
    metricFromSurface(surfaces, "match_events", "매칭 이벤트", ActivityIcon, "/internal/live-match"),
    metricFromSurface(surfaces, "support_tickets", "고객지원 티켓", LifeBuoyIcon, "/api/admin/flywheel/support-tickets/report"),
    metricFromSurface(surfaces, "billing_subscriptions", "구독 상태", ReceiptTextIcon, "/credits/subscriptions"),
  ]

  return (
    <OpsDashboardShell
      title="운영 개요"
      user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }}
    >
      <main className="flex flex-col gap-6 p-4 md:p-6">
        <section className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-2xl font-semibold tracking-tight">창업노트 운영 현황</h2>
            <Badge variant={snapshot ? "secondary" : "destructive"}>
              {snapshot ? "시스템 연결됨" : "연결 확인 필요"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            서비스 데이터, 매칭, 고객지원과 결제 운영 상태를 한곳에서 확인합니다.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <Card key={metric.label}>
              <CardHeader>
                <CardDescription>{metric.label}</CardDescription>
                <CardAction>
                  <metric.icon className="text-muted-foreground" />
                </CardAction>
                <CardTitle className="text-3xl tabular-nums">{metric.value}</CardTitle>
              </CardHeader>
              <CardFooter className="justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{metric.description}</span>
                <Link
                  className={buttonVariants({ size: "icon-xs", variant: "ghost" })}
                  href={metric.href}
                  aria-label={`${metric.label} 열기`}
                >
                  <ArrowUpRightIcon />
                </Link>
              </CardFooter>
            </Card>
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>운영 데이터 상태</CardTitle>
              <CardDescription>플라이휠을 구성하는 실제 테이블의 연결 상태와 현재 누적 건수입니다.</CardDescription>
              <CardAction>
                <Badge variant="outline">{snapshot ? formatDateTime(snapshot.generatedAt) : "대기 중"}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Progress value={surfaces.length > 0 ? (available.length / surfaces.length) * 100 : 0} />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {available.length}/{surfaces.length}
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>운영 영역</TableHead>
                      <TableHead>상태</TableHead>
                      <TableHead className="text-right">누적 건수</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {surfaces.slice(0, 8).map((surface) => (
                      <TableRow key={surface.key}>
                        <TableCell className="font-medium">{surface.label}</TableCell>
                        <TableCell>
                          <Badge variant={surface.available ? "secondary" : "destructive"}>
                            {surface.available ? "connected" : "missing"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {surface.available ? surface.count?.toLocaleString("ko-KR") : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {surfaces.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="h-28 text-center text-muted-foreground">
                          DB 연결 또는 migration 적용 상태를 확인해 주세요.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>빠른 작업</CardTitle>
                <CardDescription>반복적으로 사용하는 운영 업무입니다.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <QuickAction href="/registry-imports" icon={DatabaseZapIcon} label="공개명단 CSV 업데이트" />
                <QuickAction href="/internal/live-match" icon={HeartPulseIcon} label="라이브 매칭 확인" />
                <QuickAction href="/credits/members" icon={CircleGaugeIcon} label="회원 크레딧 조회" />
                <QuickAction href="/credits/audit" icon={Clock3Icon} label="감사 로그 확인" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>인증 경계</CardTitle>
                <CardDescription>Ops 세션은 사용자 프론트와 완전히 분리됩니다.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <BoundaryRow label="Google 도메인" value={process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im"} />
                <BoundaryRow label="프론트 세션 공유" value="false" />
                <BoundaryRow label="현재 권한" value={session.user.role} />
              </CardContent>
              <CardFooter className="gap-2 text-xs text-muted-foreground">
                <ShieldCheckIcon />
                민감한 변경은 관리자 식별자와 함께 기록됩니다.
              </CardFooter>
            </Card>
          </div>
        </section>
      </main>
    </OpsDashboardShell>
  )
}

function metricFromSurface(
  surfaces: OpsFlywheelSurface[],
  key: string,
  label: string,
  icon: typeof ActivityIcon,
  href: string,
) {
  const surface = surfaces.find((item) => item.key === key)
  return {
    label,
    value: surface?.available ? (surface.count ?? 0).toLocaleString("ko-KR") : "-",
    description: surface?.available ? "누적 데이터" : "데이터 소스 확인 필요",
    icon,
    href,
  }
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: typeof ActivityIcon; label: string }) {
  return (
    <Link className={buttonVariants({ className: "h-10 justify-start", variant: "outline" })} href={href}>
      <Icon data-icon="inline-start" />
      {label}
      <ArrowUpRightIcon data-icon="inline-end" className="ml-auto" />
    </Link>
  )
}

function BoundaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

async function loadFlywheelSnapshot() {
  try {
    return await withTimeout(getOpsFlywheelSnapshot(), 5_000)
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ops_flywheel_snapshot_timeout")), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timeout))
  })
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
}
