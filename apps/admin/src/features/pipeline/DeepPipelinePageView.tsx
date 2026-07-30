"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react"

import {
  DEEP_PIPELINE_BUCKET_LABELS,
  DEEP_STAGE_LABELS,
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
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export function DeepPipelinePageView({
  initialSummary,
  query,
  role,
}: {
  initialSummary: DeepPipelineSummary
  query: DeepPipelineQuery
  role: AdminRole
}) {
  const [notices, setNotices] = useState<DeepPipelineNoticesResult | null>(null)
  const [noticesLoading, setNoticesLoading] = useState(true)
  const [noticesError, setNoticesError] = useState<string | null>(null)
  const [noticesReloadKey, setNoticesReloadKey] = useState(0)
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeepPipelineNoticeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const bucketCounts = new Map(
    initialSummary.buckets.map((bucket) => [bucket.key, bucket.count]),
  )
  const humanReviewCount = bucketCounts.get("human_review_required") ?? 0
  const blockedCount = bucketCounts.get("blocked_or_failed") ?? 0
  const staleCount = bucketCounts.get("stale") ?? 0
  const unpublishedCount = bucketCounts.get("analysis_complete_not_published") ?? 0
  const inProgressCount = bucketCounts.get("in_progress") ?? 0
  const servingCount = bucketCounts.get("serving_complete_fresh") ?? 0
  const manualActionCount = humanReviewCount + blockedCount + staleCount + unpublishedCount
  const workerObserving = initialSummary.worker.executionMode === "observe_only"

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (query.bucket) params.set("bucket", query.bucket)
    if (query.stage) params.set("stage", query.stage)
    if (query.q) params.set("q", query.q)
    params.set("limit", String(query.limit))

    setNotices(null)
    setNoticesLoading(true)
    setNoticesError(null)
    void fetch(`/api/admin/pipeline/notices?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          data?: DeepPipelineNoticesResult
          error?: { message?: string }
        }
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "공고 목록을 불러오지 못했습니다.")
        }
        setNotices(payload.data)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setNoticesError(
          error instanceof Error ? error.message : "공고 목록을 불러오지 못했습니다.",
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setNoticesLoading(false)
      })

    return () => controller.abort()
  }, [
    noticesReloadKey,
    query.bucket,
    query.limit,
    query.q,
    query.stage,
  ])

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
            <h2 className="text-2xl font-semibold tracking-tight">딥분석 운영</h2>
            <Badge variant="secondary">
              활성 공고 {initialSummary.activeTotal.toLocaleString("ko-KR")}건
            </Badge>
            <Badge variant="outline">
              매칭 반영 {servingCount.toLocaleString("ko-KR")}건
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            공고 원문과 첨부파일을 22축으로 분석하고, AI 자동 검수 후 실제 매칭에
            반영됐는지 확인합니다.
          </p>
        </div>
        <div className="flex w-full max-w-xl flex-wrap justify-end gap-2">
          {role === "admin" || role === "owner" ? (
            <Button
              nativeButton={false}
              render={<Link href="/notice-pipeline" />}
              variant="outline"
            >
              수집·가공 관제
            </Button>
          ) : null}
          <form className="flex min-w-64 flex-1 gap-2" action="/pipeline">
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
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>지금 확인할 일</CardTitle>
          <CardDescription>
            위에서 아래 순서로 확인하면 됩니다. 숫자를 누르면 해당 공고만 표시합니다.
          </CardDescription>
          <CardAction>
            <Badge
              variant={manualActionCount > 0
                ? "destructive"
                : workerObserving
                  ? "secondary"
                  : "outline"}
            >
              {manualActionCount > 0
                ? `수동 확인 ${manualActionCount.toLocaleString("ko-KR")}건`
                : workerObserving
                  ? "운영 결정 필요"
                  : "즉시 조치 없음"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <ActionCard
            count={humanReviewCount}
            description="독립 AI 검수가 조건 누락이나 충돌을 발견했습니다. 재실행하지 말고 감사 내용을 사람이 확인합니다."
            href="/pipeline?bucket=human_review_required"
            label="1. 사람 검토"
            tone={humanReviewCount > 0 ? "warning" : "quiet"}
          />
          <ActionCard
            count={blockedCount}
            description="기술 오류나 입력 문제로 멈춘 공고입니다. 원인을 확인한 뒤 재처리합니다."
            href="/pipeline?bucket=blocked_or_failed"
            label="2. 차단·실패"
            tone={blockedCount > 0 ? "danger" : "quiet"}
          />
          <ActionCard
            count={staleCount}
            description="원문이나 첨부가 바뀌어 다시 분석해야 하는 공고입니다."
            href="/pipeline?bucket=stale"
            label="3. 원문 변경"
            tone={staleCount > 0 ? "warning" : "quiet"}
          />
          <ActionCard
            count={unpublishedCount}
            description="분석은 끝났지만 아직 매칭 결과에 반영되지 않은 공고입니다."
            href="/pipeline?bucket=analysis_complete_not_published"
            label="4. 발행 대기"
            tone={unpublishedCount > 0 ? "warning" : "quiet"}
          />
          <ActionCard
            count={inProgressCount}
            description={workerObserving
              ? `worker가 관측 모드라 작업을 가져오지 않습니다. 정책 갱신 대기 ${initialSummary.reanalysisRequiredCount.toLocaleString("ko-KR")}건을 포함해 활성화 여부를 결정해야 합니다.`
              : "자동 분석 중이거나 작업 순서를 기다리는 공고입니다."}
            href="/pipeline?bucket=in_progress"
            label={workerObserving ? "5. 자동 분석 운영 결정" : "5. 자동 분석 진행"}
            tone={workerObserving ? "warning" : "info"}
          />
        </CardContent>
      </Card>

      {!initialSummary.policyMatchesContract ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>다음 배포 전에 모델 정책 버전을 맞춰야 합니다</AlertTitle>
          <AlertDescription>
            현재 worker는 {initialSummary.modelPolicyVersion}, Ops 코드 계약은{" "}
            {initialSummary.contractModelPolicyVersion}입니다. 이 화면의 상태 계산은 실제
            worker 버전을 사용하지만, 다음 배포 전에는 두 버전을 정렬해야 합니다.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>자동처리 시스템 상태</CardTitle>
          <CardDescription>
            문제가 있는 항목만 확인하면 됩니다. 실행 ID와 revision은 아래 기술 정보에 접었습니다.
          </CardDescription>
          <CardAction>
            <Badge variant={[
              initialSummary.worker.healthy,
              initialSummary.inputPreparation.healthy,
              initialSummary.servingMonitor.healthy,
            ].every(Boolean)
              ? "outline"
              : "destructive"}
            >
              {[
                initialSummary.worker.healthy,
                initialSummary.inputPreparation.healthy,
                initialSummary.servingMonitor.healthy,
              ].every(Boolean)
                ? "시스템 정상"
                : "시스템 확인 필요"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 lg:grid-cols-3">
            <SystemStatusItem
              description={workerObserving
                ? "worker는 살아 있지만 새 작업을 가져오지 않는 관측 모드입니다."
                : `동시 작업 ${initialSummary.worker.activeWorkerCount}/${initialSummary.worker.activeLeaseCount}`}
              healthy={initialSummary.worker.healthy}
              icon={workerObserving ? EyeIcon : ServerIcon}
              title="딥분석 worker"
              value={workerObserving ? "정상 · 관측 모드" : initialSummary.worker.status ?? "상태 없음"}
            />
            <SystemStatusItem
              description={initialSummary.inputPreparation.healthy
                ? `봉인 ${initialSummary.inputPreparation.sealedCount}/${initialSummary.inputPreparation.targetCount} · 미해소 ${initialSummary.inputPreparation.unresolvedCount}`
                : `보관 실패 ${initialSummary.inputPreparation.archiveFailedCount} · 변환 실패 ${initialSummary.inputPreparation.conversionFailedCount}`}
              healthy={initialSummary.inputPreparation.healthy}
              icon={ServerIcon}
              title="원문·첨부 준비"
              value={initialSummary.inputPreparation.healthy ? "정상" : "확인 필요"}
            />
            <SystemStatusItem
              description={`최근 검증 ${formatDuration(initialSummary.servingMonitor.staleSeconds)} 전`}
              healthy={initialSummary.servingMonitor.healthy}
              icon={ShieldCheckIcon}
              title="매칭 반영 검증"
              value={initialSummary.servingMonitor.healthy
                ? `${initialSummary.servingMonitor.freshItems}/${initialSummary.servingMonitor.expectedItems} 정상`
                : `${initialSummary.servingMonitor.failedReceipts} 실패 · ${initialSummary.servingMonitor.staleReceipts} stale`}
            />
          </div>
          <details className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">기술 정보 보기</summary>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <p>
                worker revision {initialSummary.worker.serviceRevision ?? "없음"} · mode{" "}
                {initialSummary.worker.executionMode ?? "unknown"} · claim{" "}
                {initialSummary.worker.claimScope ?? "unknown"}
              </p>
              <p>
                worker heartbeat {formatDate(initialSummary.worker.heartbeatAt)}
              </p>
              <p>
                input execution {initialSummary.inputPreparation.executionId ?? "없음"} ·{" "}
                {formatDuration(initialSummary.inputPreparation.staleSeconds)} 전
              </p>
              <p>
                serving execution {initialSummary.servingMonitor.executionId ?? "없음"} ·{" "}
                확인 {initialSummary.servingMonitor.checkedItems}/
                {initialSummary.servingMonitor.expectedItems}
              </p>
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>공고 처리 목록</CardTitle>
          <CardDescription>
            {query.bucket ? DEEP_PIPELINE_BUCKET_LABELS[query.bucket] : "전체 버킷"}
            {query.stage ? ` · 다음 확인 ${DEEP_STAGE_LABELS[query.stage]}` : ""}
            {query.q ? ` · 검색 “${query.q}”` : ""}
            {" · "}
            {noticesLoading
              ? "목록 불러오는 중"
              : `${(notices?.total ?? 0).toLocaleString("ko-KR")}건`}
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
                <TableHead>분석 입력</TableHead>
                <TableHead>22축</TableHead>
                <TableHead>AI 검수·매칭 반영</TableHead>
                <TableHead>다음 확인 단계</TableHead>
                <TableHead className="text-right">증적</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {noticesLoading ? (
                Array.from({ length: 6 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={8}>
                      <Skeleton className="h-10 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : noticesError ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-28 text-center">
                    <p className="text-sm text-destructive">{noticesError}</p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => setNoticesReloadKey((value) => value + 1)}
                    >
                      다시 불러오기
                    </Button>
                  </TableCell>
                </TableRow>
              ) : (notices?.items.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    조건에 맞는 활성 공고가 없습니다.
                  </TableCell>
                </TableRow>
              ) : notices?.items.map((notice) => (
                <TableRow key={notice.grantId}>
                  <TableCell>
                    <div className="flex max-w-sm flex-col gap-1 whitespace-normal">
                      <strong>{notice.title}</strong>
                      <span className="text-xs text-muted-foreground">
                        {role === "admin" || role === "owner" ? (
                          <Link
                            className="underline-offset-4 hover:underline"
                            href={`/notice-pipeline?q=${encodeURIComponent(notice.sourceId)}`}
                          >
                            {notice.source}/{notice.sourceId}
                          </Link>
                        ) : `${notice.source}/${notice.sourceId}`}
                        {" · "}{notice.agency ?? "기관 미상"}
                        {notice.dDay === null ? "" : ` · D${notice.dDay >= 0 ? "-" : "+"}${Math.abs(notice.dDay)}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={notice.bucket === "blocked_or_failed" ? "destructive" : "secondary"}
                      className={notice.bucket === "human_review_required"
                        ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                        : undefined}
                    >
                      {DEEP_PIPELINE_BUCKET_LABELS[notice.bucket]}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {analysisProgressLabel(notice.bucket, notice.jobStatus, notice.runStatus)}
                    </p>
                    {notice.activeReleaseId ? (
                      <p className="text-xs text-muted-foreground">
                        매칭 반영 버전{" "}
                        {notice.activeReleaseRevision === null
                          ? "확인됨"
                          : `r${notice.activeReleaseRevision}`}
                      </p>
                    ) : null}
                    {notice.requiresCurrentPolicyReanalysis ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        최신 분석 정책으로 재분석 필요 ·{" "}
                        {jobStatusLabel(notice.currentPolicyJobStatus)}
                      </p>
                    ) : null}
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
                    <span className={
                      notice.terminalRoute === "human_review_required"
                        ? "font-medium text-amber-800 dark:text-amber-300"
                        : notice.terminalRoute === "conditional_promotable"
                          ? "font-medium text-sky-800 dark:text-sky-300"
                          : undefined
                    }
                    >
                      {auditVerdictLabel(notice.auditVerdict)}
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {notice.terminalRoute === "human_review_required"
                        ? "자동 발행 차단 · 감사 내용 확인"
                        : notice.terminalRoute === "conditional_promotable"
                          ? "조건부 승격 · 사용자 확인으로 보존"
                          : publicationStatusLabel(notice.publicationStatus)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={notice.firstBlockingStage ? "destructive" : "outline"}>
                      {notice.firstBlockingStage
                        ? DEEP_STAGE_LABELS[notice.firstBlockingStage]
                        : "모든 단계 완료"}
                    </Badge>
                    {notice.sourceChanged ? (
                      <p className="mt-1 text-xs text-destructive">
                        분석 후 원문이 변경됨
                      </p>
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
          {notices && notices.total > notices.items.length ? (
            <p className="pt-3 text-xs text-muted-foreground">
              우선순위가 높은 {notices.items.length}건을 표시합니다. 위 알림 카드나
              검색으로 범위를 좁혀 확인하세요.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <details className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <summary className="cursor-pointer list-none px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold">기술 보증 단계(S0–S14) 보기</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                원문 최신성부터 매칭 반영까지, 단계별 통과·누락 수를 점검할 때 펼칩니다.
              </p>
            </div>
            <ChevronRightIcon className="shrink-0 text-muted-foreground" />
          </div>
        </summary>
        <div className="border-t px-6 py-5">
          <p className="mb-4 text-sm text-muted-foreground">
            활성 {initialSummary.activeTotal.toLocaleString("ko-KR")}건 중{" "}
            {initialSummary.classifiedTotal.toLocaleString("ko-KR")}건이 분류되었습니다.
            누락은 해당 단계의 receipt가 아직 없는 공고입니다.
          </p>
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
                    확인 필요 {blockers.toLocaleString("ko-KR")}
                  </p>
                </Link>
              )
            })}
          </div>
        </div>
      </details>

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

function ActionCard({
  count,
  description,
  href,
  label,
  tone,
}: {
  count: number
  description: string
  href: string
  label: string
  tone: "danger" | "warning" | "info" | "quiet"
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group rounded-lg border p-4 transition-colors hover:bg-muted/70",
        tone === "danger" && "border-destructive/40 bg-destructive/5",
        tone === "warning" && "border-amber-500/40 bg-amber-500/5",
        tone === "info" && "border-primary/30 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">
        {count.toLocaleString("ko-KR")}건
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </Link>
  )
}

function SystemStatusItem({
  description,
  healthy,
  icon: Icon,
  title,
  value,
}: {
  description: string
  healthy: boolean
  icon: LucideIcon
  title: string
  value: string
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              healthy
                ? "bg-primary/10 text-primary"
                : "bg-destructive/10 text-destructive",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="font-semibold">{value}</p>
          </div>
        </div>
        <Badge variant={healthy ? "outline" : "destructive"}>
          {healthy ? "정상" : "확인"}
        </Badge>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

function auditVerdictLabel(value: string | null): string {
  switch (value) {
    case "concur":
      return "AI 검수 동의"
    case "disagree":
      return "AI 검수 불일치"
    case "unsure":
      return "사람 판단 필요"
    case "failed":
      return "AI 검수 실패"
    default:
      return "AI 검수 대기"
  }
}

function publicationStatusLabel(value: string | null): string {
  switch (value) {
    case "applied":
    case "published":
      return "매칭 반영 완료"
    case "prepared":
    case "applying":
      return "매칭 반영 준비"
    case "failed":
      return "매칭 반영 실패"
    case "rolling_back":
      return "매칭 반영 취소 중"
    case "rolled_back":
      return "매칭 반영 취소"
    default:
      return "매칭 미반영"
  }
}

function analysisProgressLabel(
  bucket: string,
  jobStatus: string | null,
  runStatus: string | null,
): string {
  if (bucket === "human_review_required") return "딥분석 완료 · 사람 검토 대기"
  if (runStatus === "passed") return "딥분석 완료"
  if (runStatus === "running") return "LLM 분석 중"
  if (runStatus === "failed") return "LLM 분석 실패"
  if (runStatus === "blocked") return "분석 차단됨"
  if (runStatus === "stale") return "원문 변경으로 재분석 필요"
  if (runStatus === "legacy_imported") return "기존 분석 결과"
  return jobStatusLabel(jobStatus)
}

function jobStatusLabel(value: string | null): string {
  switch (value) {
    case "pending":
      return "분석 대기"
    case "leased":
      return "작업 할당됨"
    case "retry_wait":
      return "재시도 대기"
    case "pending_budget":
      return "비용 승인 대기"
    case "succeeded":
      return "분석 작업 완료"
    case "blocked":
      return "사람 확인 필요"
    case "dead_letter":
      return "재처리 필요"
    case "canceled":
      return "작업 취소"
    default:
      return "분석 작업 미생성"
  }
}

function formatDate(value: string | null): string {
  if (!value) return "기록 없음"
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
