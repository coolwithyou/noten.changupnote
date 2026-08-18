"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  Clock3Icon,
  DatabaseIcon,
  EyeIcon,
  FileCheck2Icon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react"

import type {
  AnalysisLaunchMonitoringTarget,
  AnalysisLaunchTargetStatus,
  AnalysisMonitoringSnapshot,
  AnalysisPromotionReleaseMonitoring,
} from "@/features/analysis-monitoring/contract"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"

const TARGET_STATUS_LABELS: Record<AnalysisLaunchTargetStatus, string> = {
  pending: "대기",
  running: "실행 중",
  publishable: "분석 완료",
  held: "보류",
  failed: "실패",
  skipped: "미착수",
}

const RELEASE_STATUS_LABELS: Record<string, string> = {
  prepared: "준비됨",
  approved: "승인됨",
  canary_running: "카나리 반영 중",
  canary_passed: "카나리 통과",
  applying: "전체 반영 중",
  active: "활성",
  partial_failed: "일부 실패",
  rolling_back: "롤백 중",
  rolled_back: "롤백 완료",
}

export function AnalysisMonitoringPageView({
  snapshot,
}: {
  snapshot: AnalysisMonitoringSnapshot
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showAllTargets, setShowAllTargets] = useState(false)

  useEffect(() => {
    const interval = window.setInterval(() => {
      startTransition(() => router.refresh())
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [router])

  const refresh = () => startTransition(() => router.refresh())
  const launch = snapshot.launch
  const completedTargets = launch.summary.publishable
    + launch.summary.held
    + launch.summary.failed
    + launch.summary.skipped
  const progress = launch.targets.length > 0
    ? Math.round((completedTargets / launch.targets.length) * 100)
    : 0
  const orderedTargets = [...launch.targets].sort((a, b) => {
    const priority = (target: AnalysisLaunchMonitoringTarget) =>
      target.status === "failed" ? 0 : target.status === "held" ? 1 : target.sequence + 2
    return priority(a) - priority(b)
  })
  const visibleTargets = showAllTargets ? orderedTargets : orderedTargets.slice(0, 12)

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">딥분석 시스템</h2>
            <Badge variant={launch.state === "running" ? "default" : "outline"}>
              {launchStateLabel(launch.state)}
            </Badge>
            <Badge variant="secondary">
              {snapshot.runtime.effectiveMode === "local_subscription"
                ? "로컬 구독 실행"
                : snapshot.runtime.effectiveMode === "production_api"
                  ? "운영 API 실행"
                  : "실행 일시정지"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            승인된 launch부터 release, 서비스 반영까지 현재 정본만 추적합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {isPending ? "새로고침 중" : `기준 ${formatDate(snapshot.generatedAt)}`}
          </span>
          <Button onClick={refresh} variant="outline" size="sm" disabled={isPending}>
            <RefreshCwIcon data-icon="inline-start" />
            새로고침
          </Button>
        </div>
      </section>

      {snapshot.attention.length > 0 ? (
        <section className="grid gap-3 lg:grid-cols-2" aria-label="확인 필요 항목">
          {snapshot.attention.map((item) => (
            <Alert key={item.id} variant={item.severity === "critical" ? "destructive" : "default"}>
              <AlertTriangleIcon />
              <AlertTitle>{item.title}</AlertTitle>
              <AlertDescription>{item.description}</AlertDescription>
            </Alert>
          ))}
        </section>
      ) : (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>즉시 확인할 항목이 없습니다</AlertTitle>
          <AlertDescription>현재 관측 범위에서 공유 실행 오류나 격리 대상이 없습니다.</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-4 lg:grid-cols-3" aria-label="런타임 안전 상태">
        <StatusCard
          title="실행 권한"
          description={`generation ${snapshot.runtime.generation}`}
          value={runtimeModeLabel(snapshot.runtime.effectiveMode)}
          healthy={snapshot.runtime.activeDeepLeases === 0 || snapshot.runtime.effectiveMode !== "paused"}
          icon={ShieldCheckIcon}
          detail={`Deep lease ${snapshot.runtime.activeDeepLeases} · Kordoc lease ${snapshot.runtime.activeApplicationLeases}`}
        />
        <StatusCard
          title="운영 worker"
          description={snapshot.worker.workerId ?? "heartbeat 없음"}
          value={snapshot.worker.executionMode === "observe_only" ? "관측 모드" : snapshot.worker.status ?? "상태 없음"}
          healthy={snapshot.worker.healthy}
          icon={snapshot.worker.executionMode === "observe_only" ? EyeIcon : ServerIcon}
          detail={`활성 worker ${snapshot.worker.activeWorkerCount} · lease ${snapshot.worker.activeLeaseCount}`}
        />
        <StatusCard
          title="서빙 검증"
          description={snapshot.serving.executionId ?? "검증 이력 없음"}
          value={snapshot.serving.healthy ? "최신·정상" : "확인 필요"}
          healthy={snapshot.serving.healthy}
          icon={DatabaseIcon}
          detail={`정상 ${snapshot.serving.freshItems}/${snapshot.serving.expectedItems} · stale ${snapshot.serving.staleReceipts}`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>현재 launch</CardTitle>
          <CardDescription>
            {launch.seriesId ?? "로컬 launch 없음"}
            {launch.model ? ` · ${launch.model}` : ""}
            {launch.concurrency ? ` · 동시성 ${launch.concurrency}` : ""}
            {launch.withApplicationRoundtrip ? " · Kordoc 포함" : ""}
          </CardDescription>
          <CardAction>
            <Badge variant={launch.stopReason === "systemic-failure" ? "destructive" : "outline"}>
              {launch.stopReason ?? launchStateLabel(launch.state)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {launch.targets.length > 0 ? (
            <>
              <Progress value={progress}>
                <ProgressLabel>대상 진행률</ProgressLabel>
                <ProgressValue>{() => `${completedTargets}/${launch.targets.length}`}</ProgressValue>
              </Progress>
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <CountCard label="실행 중" value={launch.summary.running} />
                <CountCard label="완료" value={launch.summary.publishable} />
                <CountCard label="보류" value={launch.summary.held} />
                <CountCard label="실패" value={launch.summary.failed} />
                <CountCard label="대기" value={launch.summary.pending} />
                <CountCard label="미착수" value={launch.summary.skipped} />
              </div>
              <Separator />
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium">대상별 상태</h3>
                    <p className="text-xs text-muted-foreground">실패와 보류 항목을 먼저 표시합니다.</p>
                  </div>
                  {orderedTargets.length > 12 ? (
                    <Button
                      onClick={() => setShowAllTargets((value) => !value)}
                      variant="ghost"
                      size="sm"
                    >
                      {showAllTargets
                        ? <ChevronUpIcon data-icon="inline-start" />
                        : <ChevronDownIcon data-icon="inline-start" />}
                      {showAllTargets ? "접기" : `전체 ${orderedTargets.length}건 보기`}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {visibleTargets.map((target) => <TargetItem key={target.grantId} target={target} />)}
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {launch.available
                ? "표시할 launch 산출물이 없습니다."
                : "이 런타임에서는 로컬 launch 산출물에 접근할 수 없습니다."}
            </div>
          )}
          <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
            <TechnicalValue label="manifest" value={shortId(launch.manifestSha256)} />
            <TechnicalValue label="grant" value={shortId(launch.grantSha256)} />
            <TechnicalValue label="receipt" value={shortId(launch.receiptSha256)} />
            <TechnicalValue label="최근 갱신" value={formatDate(launch.updatedAt)} />
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Release와 서비스 반영</CardTitle>
            <CardDescription>승인·카나리·전체 반영 원장의 최근 상태입니다.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snapshot.releases.length > 0 ? snapshot.releases.map((release) => (
              <ReleaseItem key={`${release.releaseId}:${release.revision}`} release={release} />
            )) : (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                준비된 release가 없습니다.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>입력 준비</CardTitle>
            <CardDescription>원문·첨부 봉인 worker의 최근 heartbeat입니다.</CardDescription>
            <CardAction>
              <Badge variant={snapshot.inputPreparation.healthy ? "outline" : "destructive"}>
                {snapshot.inputPreparation.healthy ? "정상" : "확인 필요"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Progress value={percentage(snapshot.inputPreparation.sealedCount, snapshot.inputPreparation.targetCount)}>
              <ProgressLabel>입력 봉인</ProgressLabel>
              <ProgressValue>
                {() => `${snapshot.inputPreparation.sealedCount}/${snapshot.inputPreparation.targetCount}`}
              </ProgressValue>
            </Progress>
            <div className="grid grid-cols-2 gap-3">
              <CountCard label="미해결" value={snapshot.inputPreparation.unresolvedCount} />
              <CountCard label="실패" value={snapshot.inputPreparation.failedCount} />
            </div>
            <p className="text-xs text-muted-foreground">
              최근 heartbeat {formatRelative(snapshot.inputPreparation.staleSeconds)}
            </p>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}

function StatusCard({
  title,
  description,
  value,
  healthy,
  icon: Icon,
  detail,
}: {
  title: string
  description: string
  value: string
  healthy: boolean
  icon: typeof ServerIcon
  detail: string
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription className="truncate" title={description}>{description}</CardDescription>
        <CardAction>
          <Badge variant={healthy ? "outline" : "destructive"}>{healthy ? "정상" : "확인"}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <strong className="text-lg font-semibold">{value}</strong>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </CardContent>
    </Card>
  )
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardAction><strong className="text-lg tabular-nums">{value}</strong></CardAction>
      </CardHeader>
    </Card>
  )
}

function TargetItem({ target }: { target: AnalysisLaunchMonitoringTarget }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border p-3 [content-visibility:auto]">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">#{target.sequence + 1}</span>
          <Badge variant={targetBadgeVariant(target.status)}>{TARGET_STATUS_LABELS[target.status]}</Badge>
          {target.applicationRoundtripStatus ? (
            <Badge variant="secondary">Kordoc {target.applicationRoundtripStatus}</Badge>
          ) : null}
        </div>
        <p className="mt-2 truncate font-medium" title={target.title ?? target.grantId}>
          {target.title ?? target.grantId}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {[target.source, target.stratum].filter(Boolean).join(" · ")}
        </p>
        {target.error ? (
          <p className="mt-2 line-clamp-2 text-xs text-destructive" title={target.error}>{target.error}</p>
        ) : null}
      </div>
    </div>
  )
}

function ReleaseItem({ release }: { release: AnalysisPromotionReleaseMonitoring }) {
  const healthy = release.failedItems === 0 && release.status !== "partial_failed"
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <FileCheck2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-48 flex-1">
        <p className="truncate font-medium" title={release.releaseId}>{release.releaseId}</p>
        <p className="text-xs text-muted-foreground">
          revision {release.revision} · 생성 {formatDate(release.createdAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={healthy ? "outline" : "destructive"}>
          {RELEASE_STATUS_LABELS[release.status] ?? release.status}
        </Badge>
        <span className="text-xs tabular-nums text-muted-foreground">
          반영 {release.appliedItems}/{release.totalItems} · 실패 {release.failedItems}
        </span>
      </div>
    </div>
  )
}

function TechnicalValue({ label, value }: { label: string; value: string }) {
  return <span><strong className="font-medium text-foreground">{label}</strong> {value}</span>
}

function launchStateLabel(state: AnalysisMonitoringSnapshot["launch"]["state"]): string {
  if (state === "prepared") return "승인 대기"
  if (state === "approved") return "실행 대기"
  if (state === "running") return "실행 중"
  if (state === "finished") return "실행 종료"
  return "관측 불가"
}

function runtimeModeLabel(mode: AnalysisMonitoringSnapshot["runtime"]["effectiveMode"]): string {
  if (mode === "local_subscription") return "로컬 lease 활성"
  if (mode === "production_api") return "운영 API 허용"
  return "새 실행 차단"
}

function targetBadgeVariant(status: AnalysisLaunchTargetStatus): "default" | "secondary" | "destructive" | "outline" | "ghost" {
  if (status === "running") return "default"
  if (status === "failed") return "destructive"
  if (status === "held" || status === "pending") return "secondary"
  if (status === "skipped") return "ghost"
  return "outline"
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0
}

function shortId(value: string | null): string {
  return value ? `${value.slice(0, 10)}…` : "없음"
}

function formatDate(value: string | null): string {
  if (!value) return "기록 없음"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function formatRelative(seconds: number | null): string {
  if (seconds === null) return "기록 없음"
  if (seconds < 60) return `${seconds}초 전`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}분 전`
  return `${Math.floor(seconds / 3_600)}시간 전`
}
