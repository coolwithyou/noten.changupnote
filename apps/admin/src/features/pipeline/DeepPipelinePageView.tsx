"use client"

import Link from "next/link"
import { useState } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react"

import {
  DEEP_PIPELINE_BUCKET_LABELS,
  type DeepPipelineNoticeDetail,
  type DeepPipelineNoticesResult,
  type DeepPipelineSummary,
} from "@/features/pipeline/contract"
import { DeepNoticeSheet } from "@/features/pipeline/DeepNoticeSheet"
import type { DeepPipelineQuery } from "@/lib/server/admin/deepPipeline"
import type { AdminRole } from "@/lib/server/auth/adminUsers"
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
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function DeepPipelinePageView({
  initialNotices,
  initialSummary,
  query,
  role,
}: {
  initialNotices: DeepPipelineNoticesResult
  initialSummary: DeepPipelineSummary
  query: DeepPipelineQuery
  role: AdminRole
}) {
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeepPipelineNoticeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const openDetail = async (grantId: string) => {
    setSelectedGrantId(grantId)
    setDetail(null)
    setDetailLoading(true)
    try {
      const response = await fetch(`/api/admin/pipeline/notices/${grantId}`, {
        cache: "no-store",
      })
      const payload = await response.json() as {
        data?: DeepPipelineNoticeDetail
        error?: { message?: string }
      }
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "증적을 불러오지 못했습니다.")
      }
      setDetail(payload.data)
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">활성 공고 딥분석 보증</h2>
            <Badge variant={initialSummary.degraded ? "destructive" : "secondary"}>
              {initialSummary.degraded ? "집계 degraded" : "버킷 보존식 정상"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            수동 완료 체크가 아니라 최신 job/run의 S0~S14 검증 receipt와 원문 최신성으로 계산합니다.
          </p>
        </div>
        <form className="flex w-full max-w-sm gap-2" action="/pipeline">
          {query.bucket ? <input type="hidden" name="bucket" value={query.bucket} /> : null}
          {query.stage ? <input type="hidden" name="stage" value={query.stage} /> : null}
          <Input
            aria-label="공고 검색"
            defaultValue={query.q}
            name="q"
            placeholder="제목, 기관, sourceId"
          />
          <Button type="submit" variant="outline">
            <SearchIcon /> 검색
          </Button>
        </form>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {!initialSummary.worker.healthy ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>분석 worker 경고</AlertTitle>
            <AlertDescription>
              {initialSummary.worker.heartbeatAt
                ? `${formatDate(initialSummary.worker.heartbeatAt)} · status ${initialSummary.worker.status} · active worker/lease ${initialSummary.worker.activeWorkerCount}/${initialSummary.worker.activeLeaseCount} · stale active ${initialSummary.worker.staleActiveWorkerCount}`
                : "현재 model policy의 worker heartbeat가 없습니다."}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <ServerIcon />
            <AlertTitle>
              {initialSummary.worker.executionMode === "observe_only"
                ? "worker 정상 · 관측 대기"
                : "worker 정상"}
            </AlertTitle>
            <AlertDescription>
              {initialSummary.worker.serviceRevision} · mode{" "}
              {initialSummary.worker.executionMode ?? "unknown"} ·{" "}
              claim {initialSummary.worker.claimScope ?? "unknown"}
              {initialSummary.worker.claimScope === "bounded"
                ? ` ${initialSummary.worker.claimCohortCount}건/${initialSummary.worker.claimCohortSha256?.slice(0, 12) ?? "no-hash"}`
                : ""}
              {" "}· {initialSummary.worker.status} · active{" "}
              {initialSummary.worker.activeWorkerCount}/{initialSummary.worker.activeLeaseCount}
              {initialSummary.worker.currentJobId
                ? ` · job ${initialSummary.worker.currentJobId.slice(0, 8)}`
                : ""}
              {" "}· {formatDuration(initialSummary.worker.staleSeconds)} 전
            </AlertDescription>
          </Alert>
        )}

        {initialSummary.inputPreparation.healthy ? (
          <Alert>
            <ServerIcon />
            <AlertTitle>입력 준비 worker 정상</AlertTitle>
            <AlertDescription>
              {initialSummary.inputPreparation.executionId} · sealed{" "}
              {initialSummary.inputPreparation.sealedCount}/
              {initialSummary.inputPreparation.targetCount} · 미해소{" "}
              {initialSummary.inputPreparation.unresolvedCount} · 변환 등록{" "}
              {initialSummary.inputPreparation.conversionJobsEnqueued} · 캐시{" "}
              {initialSummary.inputPreparation.conversionCacheHits} ·{" "}
              {formatDuration(initialSummary.inputPreparation.staleSeconds)} 전
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>입력 준비 worker 경고</AlertTitle>
            <AlertDescription>
              {initialSummary.inputPreparation.heartbeatAt
                ? `${formatDate(initialSummary.inputPreparation.heartbeatAt)} · status ${initialSummary.inputPreparation.status} · archive 실패 ${initialSummary.inputPreparation.archiveFailedCount} · conversion 실패 ${initialSummary.inputPreparation.conversionFailedCount} · 등록 경고 ${initialSummary.inputPreparation.conversionRegistrationWarnings}`
                : "Cloud Run input-preparation heartbeat가 없습니다."}
            </AlertDescription>
          </Alert>
        )}

        {initialSummary.servingMonitor.healthy ? (
          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>serving monitor 정상</AlertTitle>
            <AlertDescription>
              {initialSummary.servingMonitor.executionId} · fresh{" "}
              {initialSummary.servingMonitor.freshItems}/{initialSummary.servingMonitor.expectedItems} ·{" "}
              {formatDuration(initialSummary.servingMonitor.staleSeconds)} 전
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>serving monitor 경고</AlertTitle>
            <AlertDescription>
              {initialSummary.servingMonitor.verifiedAt
                ? `${formatDate(initialSummary.servingMonitor.verifiedAt)} 검증: 확인 ${initialSummary.servingMonitor.checkedItems}/${initialSummary.servingMonitor.expectedItems}, failed ${initialSummary.servingMonitor.failedReceipts}, stale ${initialSummary.servingMonitor.staleReceipts}`
                : "Cloud Run serving monitor의 검증 receipt가 없습니다."}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {initialSummary.buckets.map((bucket) => (
          <Card key={bucket.key} size="sm">
            <CardHeader>
              <CardTitle>{bucket.label}</CardTitle>
              <CardDescription>활성 분모의 배타적 최종 상태</CardDescription>
              <CardAction>
                <Badge variant={bucket.key === "blocked_or_failed" ? "destructive" : "outline"}>
                  {bucket.count.toLocaleString("ko-KR")}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Button
                variant="ghost"
                className="w-full justify-between"
                nativeButton={false}
                render={<Link href={`/pipeline?bucket=${bucket.key}`} />}
              >
                공고 보기 <ChevronRightIcon />
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>단계별 보증 funnel</CardTitle>
          <CardDescription>
            활성 {initialSummary.activeTotal.toLocaleString("ko-KR")} =
            분류 {initialSummary.classifiedTotal.toLocaleString("ko-KR")} · 누락은 receipt가 아직 없는 공고입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {initialSummary.stages.map((stage) => {
              const blockers = stage.failed + stage.blocked + stage.stale + stage.missing
              return (
                <Link
                  key={stage.stage}
                  href={`/pipeline?stage=${stage.stage}`}
                  className="rounded-lg border p-3 transition-colors hover:bg-muted"
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">{stage.label}</strong>
                    {blockers === 0
                      ? <CheckCircle2Icon className="text-primary" />
                      : <AlertTriangleIcon className="text-destructive" />}
                  </div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">
                    {stage.passed.toLocaleString("ko-KR")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    실패·차단·stale·누락 {blockers.toLocaleString("ko-KR")}
                  </p>
                </Link>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>트리아지 큐</CardTitle>
          <CardDescription>
            {query.bucket ? DEEP_PIPELINE_BUCKET_LABELS[query.bucket] : "전체 버킷"}
            {query.stage ? ` · 첫 blocker ${query.stage}` : ""}
            {query.q ? ` · 검색 “${query.q}”` : ""}
            {" · "}{initialNotices.total.toLocaleString("ko-KR")}건
          </CardDescription>
          <CardAction>
            {(query.bucket || query.stage || query.q) ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href="/pipeline" />}
              >
                필터 해제
              </Button>
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>공고</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>첨부</TableHead>
                <TableHead>입력·모델</TableHead>
                <TableHead>22축</TableHead>
                <TableHead>감사·발행</TableHead>
                <TableHead>blocker</TableHead>
                <TableHead className="text-right">증적</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialNotices.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    조건에 맞는 활성 공고가 없습니다.
                  </TableCell>
                </TableRow>
              ) : initialNotices.items.map((notice) => (
                <TableRow key={notice.grantId}>
                  <TableCell>
                    <div className="flex max-w-sm flex-col gap-1 whitespace-normal">
                      <strong>{notice.title}</strong>
                      <span className="text-xs text-muted-foreground">
                        {notice.source}/{notice.sourceId} · {notice.agency ?? "기관 미상"}
                        {notice.dDay === null ? "" : ` · D${notice.dDay >= 0 ? "-" : "+"}${Math.abs(notice.dDay)}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={notice.bucket === "blocked_or_failed" ? "destructive" : "secondary"}>
                      {DEEP_PIPELINE_BUCKET_LABELS[notice.bucket]}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {notice.jobStatus ?? "job 없음"} / {notice.runStatus ?? "run 없음"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">
                      {notice.archivedCount}/{notice.attachmentCount} 보관
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {notice.convertedCount} 변환 · {notice.blockedAttachmentCount} 실패
                    </p>
                  </TableCell>
                  <TableCell>
                    <span>{formatNumber(notice.inputChars)}자</span>
                    <p className="text-xs text-muted-foreground">
                      {notice.model ?? "대기"} · {formatCost(notice.costUsd)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <span>조건 {notice.axisCounts.condition_found}</span>
                    <p className="text-xs text-muted-foreground">
                      없음 {notice.axisCounts.inspected_no_condition} · 예외{" "}
                      {notice.axisCounts.ambiguous + notice.axisCounts.input_missing + notice.axisCounts.unassessed}
                    </p>
                  </TableCell>
                  <TableCell>
                    <span>{notice.auditVerdict ?? "감사 대기"}</span>
                    <p className="text-xs text-muted-foreground">
                      {notice.publicationStatus ?? "미발행"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={notice.firstBlockingStage ? "destructive" : "outline"}>
                      {notice.firstBlockingStage ?? "없음"}
                    </Badge>
                    {notice.sourceChanged ? (
                      <p className="mt-1 text-xs text-destructive">job 이후 원문 변경</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openDetail(notice.grantId)}
                    >
                      열기 <ChevronRightIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {initialNotices.total > initialNotices.items.length ? (
            <p className="pt-3 text-xs text-muted-foreground">
              상위 {initialNotices.items.length}건을 표시합니다. blocker 또는 검색 필터로 범위를 좁혀 증적을 확인하세요.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <DeepNoticeSheet
        detail={detail}
        loading={detailLoading}
        open={selectedGrantId !== null}
        role={role}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedGrantId(null)
            setDetail(null)
          }
        }}
        onRefresh={async () => {
          if (selectedGrantId) await openDetail(selectedGrantId)
        }}
      />
    </main>
  )
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value))
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "알 수 없음"
  if (seconds < 60) return `${seconds}초`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`
  return `${Math.floor(seconds / 3600)}시간`
}

function formatNumber(value: number | null): string {
  return value === null ? "미상" : new Intl.NumberFormat("ko-KR").format(value)
}

function formatCost(value: number | null): string {
  return value === null ? "비용 미상" : `$${value.toFixed(4)}`
}
