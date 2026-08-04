"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { PipelineCanvas } from "./PipelineCanvas"
import { PipelineNoticeDialog } from "./PipelineNoticeDialog"
import { PipelineQueue } from "./PipelineQueue"
import {
  PIPELINE_ACTION_LABELS,
  PIPELINE_LENSES,
  PIPELINE_LENS_LABELS,
  PIPELINE_SORT_LABELS,
  PIPELINE_SORTS,
  PIPELINE_SOURCES,
  PIPELINE_SOURCE_LABELS,
  isPipelineBucket,
  isPipelineLens,
  isPipelineSource,
  type PipelineBucket,
  type PipelineAction,
  type PipelineActionResponse,
  type PipelineActionTarget,
  type PipelineLens,
  type PipelineNoticeItem,
  type PipelineNoticesResult,
  type PipelineQueryState,
  type PipelineSort,
  type PipelineSummary,
} from "./contract"

interface PipelinePageViewProps {
  initialSummary: PipelineSummary
  initialNotices: PipelineNoticesResult
  query: PipelineQueryState
  canMutate: boolean
  canReconvert: boolean
  canViewDeepAnalysis: boolean
}

interface PendingAction {
  action: PipelineAction
  targets: PipelineActionTarget[]
}

export function PipelinePageView({
  initialSummary,
  initialNotices,
  query,
  canMutate,
  canReconvert,
  canViewDeepAnalysis,
}: PipelinePageViewProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState(initialSummary)
  const [selectedNotice, setSelectedNotice] = useState<PipelineNoticeItem | null>(null)
  const [searchText, setSearchText] = useState(query.q)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isActionPending, setIsActionPending] = useState(false)
  const [actionRefreshToken, setActionRefreshToken] = useState(0)
  const lastJumpQuery = useRef<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => setSummary(initialSummary), [initialSummary])
  useEffect(() => setSearchText(query.q), [query.q])
  useEffect(() => {
    if (
      query.q
      && initialNotices.items.length === 1
      && lastJumpQuery.current !== query.q
    ) {
      lastJumpQuery.current = query.q
      setSelectedNotice(initialNotices.items[0] ?? null)
    }
  }, [initialNotices.items, query.q])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = async () => {
      if (document.visibilityState !== "visible") return
      const params = new URLSearchParams({ lens: query.lens })
      if (query.includeClosed) params.set("closed", "include")
      try {
        const response = await fetch(`/api/admin/notice-pipeline/summary?${params.toString()}`, {
          signal: controller.signal,
        })
        const body = await response.json() as { data?: PipelineSummary }
        if (response.ok && body.data) setSummary(body.data)
      } catch {
        // 다음 60초 폴링 또는 수동 새로고침에서 다시 시도한다.
      }
    }

    const timer = window.setInterval(() => {
      void refresh()
    }, initialSummary.refreshAfterSeconds * 1000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [initialSummary.refreshAfterSeconds, query.includeClosed, query.lens])

  const pushQuery = useCallback((patch: Record<string, string | null>, resetPage = true) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") params.delete(key)
      else params.set(key, value)
    }
    params.delete("cursor")
    if (resetPage) params.delete("page")
    startTransition(() => {
      const queryString = params.toString()
      router.push(queryString ? `${pathname}?${queryString}` : pathname)
    })
  }, [pathname, router, searchParams])
  const pageHref = useCallback((page: number) => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("cursor")
    if (page <= 1) params.delete("page")
    else params.set("page", String(page))
    const queryString = params.toString()
    return `${queryString ? `${pathname}?${queryString}` : pathname}#pipeline-queue`
  }, [pathname, searchParams])

  const changeLens = useCallback((lens: PipelineLens) => {
    pushQuery({ lens, bucket: null })
  }, [pushQuery])
  const changeBucket = useCallback((bucket: PipelineBucket | null) => {
    pushQuery({ bucket: bucket ?? "all" })
  }, [pushQuery])
  const changeSource = useCallback((source: string | null) => {
    pushQuery({ source })
  }, [pushQuery])
  const changeSort = useCallback((sort: PipelineSort) => {
    pushQuery({ sort })
  }, [pushQuery])
  const requestAction = useCallback((
    action: PipelineAction,
    targets: PipelineActionTarget[],
  ) => {
    if (!canMutate) {
      toast.error("이 작업은 admin 이상의 권한이 필요합니다.")
      return
    }
    if (action === "reconvert" && !canReconvert) {
      toast.error("변환 서버 연결이 설정되지 않아 재변환을 요청할 수 없습니다.")
      return
    }
    setPendingAction({ action, targets })
  }, [canMutate, canReconvert])
  const executeAction = useCallback(async () => {
    if (!pendingAction || isActionPending) return
    setIsActionPending(true)
    try {
      const response = await fetch("/api/admin/notice-pipeline/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          action: pendingAction.action,
          targets: pendingAction.targets,
        }),
      })
      const body = await response.json() as {
        data?: PipelineActionResponse
        error?: { message?: string }
      }
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "수집·가공 관제 액션을 처리하지 못했습니다.")
      }
      const { totals } = body.data
      const message = pendingAction.action === "mark_reviewed"
        ? `${totals.succeeded}건 기본 추출 검수 완료 · criteria ${totals.affected}건 갱신`
        : `${totals.succeeded}건 성공 · 변환 job ${totals.affected}건 요청`
      if (totals.failed > 0 || totals.partial > 0) {
        toast.warning(`${message} · 부분/실패 ${totals.partial + totals.failed}건`)
      } else {
        toast.success(message)
      }
      setPendingAction(null)
      setActionRefreshToken((value) => value + 1)
      startTransition(() => router.refresh())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "수집·가공 관제 액션을 처리하지 못했습니다.")
    } finally {
      setIsActionPending(false)
    }
  }, [isActionPending, pendingAction, router])
  const activeQueueFilterCount = [
    Boolean(query.q),
    Boolean(query.source),
    query.sort !== "deadline",
    query.includeClosed,
  ].filter(Boolean).length
  const firstVisibleItem = initialNotices.total === 0
    ? 0
    : (initialNotices.page - 1) * initialNotices.pageSize + 1
  const lastVisibleItem = Math.min(
    initialNotices.page * initialNotices.pageSize,
    initialNotices.total,
  )
  const paginationItems = buildPaginationItems(
    initialNotices.page,
    initialNotices.pageCount,
  )

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-2xl font-semibold tracking-tight">수집·가공 관제</h2>
            <Badge variant="secondary">
              조회 {summary.total.toLocaleString("ko-KR")}건
            </Badge>
            {isPending ? (
              <Badge variant="outline">
                <Spinner data-icon="inline-start" />
                갱신 중
              </Badge>
            ) : null}
            {!canReconvert ? (
              <Badge title="CONVERSION_SERVER_URL과 CONVERSION_SHARED_SECRET이 필요합니다." variant="outline">
                재변환 서버 미연결
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            공고 수집·첨부 변환·기본 추출 상태를 관리합니다.
          </p>
        </div>
        {canViewDeepAnalysis ? (
          <Button
            nativeButton={false}
            render={<Link href="/pipeline" />}
            variant="outline"
          >
            딥분석 관제
          </Button>
        ) : null}
      </section>

      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>기본 추출 완료와 딥분석 완료는 다릅니다</AlertTitle>
        <AlertDescription>
          이 화면의 발행·검수 완료는 수집 데이터와 기본 추출에만 적용됩니다.
          22축 근거 검증과 AI 자동 검수, 실제 매칭 서빙 여부는 딥분석 관제에서 확인합니다.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>지원 바이너리 선분석</CardTitle>
          <CardDescription>
            HWP/HWPX 빠른 작성 필드를 사용자 접근 전에 준비하는 별도 Kordoc 큐입니다.
          </CardDescription>
          <CardAction>
            <Badge variant={summary.applicationPrecompute.needsAttention > 0 ? "destructive" : "outline"}>
              {summary.applicationPrecompute.needsAttention > 0
                ? `확인 ${summary.applicationPrecompute.needsAttention}건`
                : "오류 없음"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <PrecomputeMetric label="대기·재시도" value={summary.applicationPrecompute.queued} />
          <PrecomputeMetric label="실행 중" value={summary.applicationPrecompute.running} />
          <PrecomputeMetric label="완료" value={summary.applicationPrecompute.succeeded} />
          <PrecomputeMetric label="생성 필드" value={summary.applicationPrecompute.fieldCount} />
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">비용 · worker</p>
            <p className="mt-1 font-medium tabular-nums">
              {summary.applicationPrecompute.costUsd === null
                ? "비용 미집계"
                : `$${summary.applicationPrecompute.costUsd.toFixed(4)}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.applicationPrecompute.workerStale
                ? "worker 미기동·지연"
                : summary.applicationPrecompute.workerStatus ?? "worker 미기동"}
            </p>
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-4 md:grid-cols-3">
        {summary.sources.map((source) => (
          <Card key={source.source}>
            <CardHeader>
              <CardDescription>{source.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {source.openCount.toLocaleString("ko-KR")}
              </CardTitle>
              <CardAction>
                {source.stale ? (
                  <AlertTriangleIcon className="text-destructive" />
                ) : (
                  <CheckCircle2Icon className="text-[var(--success)]" />
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3 text-sm">
              <span>오늘 +{source.todayNewCount.toLocaleString("ko-KR")}</span>
              <Badge variant={source.stale ? "destructive" : "outline"}>
                {source.stale ? "수집 지연" : "수집 정상"}
              </Badge>
            </CardContent>
            <CardFooter className="gap-2 text-xs text-muted-foreground">
              <Clock3Icon />
              최근 수집 {formatDateTime(source.lastCollectedAt)}
            </CardFooter>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>관제 렌즈</CardTitle>
          <CardDescription>
            버킷을 선택하면 아래 트리아지 큐가 같은 조건으로 갱신됩니다.
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => startTransition(() => router.refresh())}
            >
              <RefreshCwIcon data-icon="inline-start" />
              새로고침
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldGroup>
            <Field orientation="responsive">
              <FieldTitle>렌즈</FieldTitle>
              <ToggleGroup
                value={[query.lens]}
                variant="outline"
                onValueChange={(values) => {
                  const value = values[0]
                  if (value && isPipelineLens(value)) changeLens(value)
                }}
              >
                {PIPELINE_LENSES.map((lens) => (
                  <ToggleGroupItem key={lens} value={lens}>
                    {PIPELINE_LENS_LABELS[lens]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>

            <Field orientation="responsive">
              <FieldTitle>버킷</FieldTitle>
              <ToggleGroup
                className="flex-wrap justify-start"
                value={[query.bucket ?? "all"]}
                variant="outline"
                onValueChange={(values) => {
                  const value = values[0]
                  if (!value) return
                  changeBucket(isPipelineBucket(value) ? value : null)
                }}
              >
                <ToggleGroupItem value="all">
                  전체 {summary.total.toLocaleString("ko-KR")}
                </ToggleGroupItem>
                {summary.buckets.map((bucket) => (
                  <ToggleGroupItem key={bucket.key} value={bucket.key}>
                    {bucket.label} {bucket.count.toLocaleString("ko-KR")}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <PipelineCanvas
        summary={summary}
        activeBucket={query.bucket}
        activeSource={query.source}
        onBucketChange={changeBucket}
        onSourceChange={changeSource}
      />

      <Card id="pipeline-queue" className="scroll-mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>트리아지 큐</CardTitle>
            {activeQueueFilterCount > 0 ? (
              <Badge variant="secondary">
                필터 {activeQueueFilterCount}
              </Badge>
            ) : null}
          </div>
          <CardDescription>
            {initialNotices.total.toLocaleString("ko-KR")}건 중{" "}
            {`${firstVisibleItem.toLocaleString("ko-KR")}–${lastVisibleItem.toLocaleString("ko-KR")}건 표시`}
          </CardDescription>
          <CardAction>
            <Badge variant="outline">
              {initialNotices.page.toLocaleString("ko-KR")} /{" "}
              {initialNotices.pageCount.toLocaleString("ko-KR")} 페이지
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="rounded-xl border bg-muted/20 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              pushQuery({ q: searchText.trim() })
            }}
          >
            <FieldGroup className="grid gap-3 lg:grid-cols-[minmax(20rem,1fr)_minmax(10rem,0.32fr)_minmax(12rem,0.38fr)]">
              <Field>
                <FieldLabel htmlFor="pipeline-search">공고 검색</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="pipeline-search"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="공고명, 기관, sourceId"
                  />
                  <InputGroupAddon align="inline-end">
                    {searchText ? (
                      <InputGroupButton
                        aria-label="검색어 지우기"
                        size="icon-xs"
                        onClick={() => {
                          setSearchText("")
                          if (query.q) pushQuery({ q: null })
                        }}
                      >
                        <XIcon data-icon="inline-start" />
                      </InputGroupButton>
                    ) : null}
                    <InputGroupButton type="submit" variant="secondary">
                      <SearchIcon data-icon="inline-start" />
                      검색
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>

              <Field>
                <FieldLabel htmlFor="pipeline-source">소스</FieldLabel>
                <Select
                  value={query.source ?? "all"}
                  onValueChange={(value) => {
                    if (!value) return
                    changeSource(isPipelineSource(value) ? value : null)
                  }}
                >
                  <SelectTrigger id="pipeline-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">전체 소스</SelectItem>
                      {PIPELINE_SOURCES.map((source) => (
                        <SelectItem key={source} value={source}>
                          {PIPELINE_SOURCE_LABELS[source]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="pipeline-sort">정렬</FieldLabel>
                <Select
                  value={query.sort}
                  onValueChange={(value) => {
                    if (value && PIPELINE_SORTS.includes(value as PipelineSort)) {
                      changeSort(value as PipelineSort)
                    }
                  }}
                >
                  <SelectTrigger id="pipeline-sort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {PIPELINE_SORTS.map((sort) => (
                        <SelectItem key={sort} value={sort}>
                          {PIPELINE_SORT_LABELS[sort]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <Field orientation="horizontal" className="w-auto">
                <Checkbox
                  id="pipeline-closed"
                  checked={query.includeClosed}
                  onCheckedChange={(value) => {
                    pushQuery({ closed: value ? "include" : null })
                  }}
                />
                <FieldLabel htmlFor="pipeline-closed">마감 공고 포함</FieldLabel>
              </Field>

              <Button
                disabled={activeQueueFilterCount === 0}
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearchText("")
                  pushQuery({
                    q: null,
                    source: null,
                    sort: null,
                    closed: null,
                  })
                }}
              >
                <XIcon data-icon="inline-start" />
                큐 필터 초기화
              </Button>
            </div>
          </form>

          <PipelineQueue
            items={initialNotices.items}
            sort={query.sort}
            canMutate={canMutate}
            canReconvert={canReconvert}
            resetSelectionToken={actionRefreshToken}
            openNoticeId={selectedNotice?.grantId ?? null}
            onClose={() => setSelectedNotice(null)}
            onOpen={setSelectedNotice}
            onRequestAction={requestAction}
            onSortChange={changeSort}
          />

          <div className="flex flex-col gap-3 border-t pt-4 lg:flex-row lg:items-center lg:justify-between">
            <span className="text-xs text-muted-foreground">
              페이지당 {initialNotices.pageSize.toLocaleString("ko-KR")}건 ·{" "}
              {formatDateTime(initialNotices.generatedAt)} 기준
            </span>
            <Pagination className="mx-0 w-auto justify-start lg:justify-end">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    aria-disabled={!initialNotices.hasPrevious}
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    href={pageHref(Math.max(1, initialNotices.page - 1))}
                    tabIndex={initialNotices.hasPrevious ? undefined : -1}
                    text="이전"
                  />
                </PaginationItem>
                {paginationItems.map((item) => (
                  typeof item === "number" ? (
                    <PaginationItem key={item}>
                      <PaginationLink
                        aria-label={`${item}페이지로 이동`}
                        href={pageHref(item)}
                        isActive={item === initialNotices.page}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  )
                ))}
                <PaginationItem>
                  <PaginationNext
                    aria-disabled={!initialNotices.hasNext}
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    href={pageHref(
                      Math.min(initialNotices.pageCount, initialNotices.page + 1),
                    )}
                    tabIndex={initialNotices.hasNext ? undefined : -1}
                    text="다음"
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </CardContent>
      </Card>

      <PipelineNoticeDialog
        canViewDeepAnalysis={canViewDeepAnalysis}
        notice={selectedNotice}
        canMutate={canMutate}
        canReconvert={canReconvert}
        refreshToken={actionRefreshToken}
        onClose={() => setSelectedNotice(null)}
        onRequestAction={requestAction}
      />

      <AlertDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open && !isActionPending) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldCheckIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {pendingAction ? PIPELINE_ACTION_LABELS[pendingAction.action] : "수집·가공 관제 액션"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              선택한 {pendingAction?.targets.length.toLocaleString("ko-KR") ?? 0}건에
              {pendingAction?.action === "mark_reviewed"
                ? " 기본 추출 검수 완료 상태를 기록하고 추출 이력을 남깁니다. 딥분석 완료 상태는 변경하지 않습니다."
                : " 변환 서버 재처리를 요청합니다. 완료 결과는 변환 폴링에서 반영됩니다."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActionPending}>취소</AlertDialogCancel>
            <AlertDialogAction
              disabled={isActionPending}
              onClick={() => void executeAction()}
            >
              {isActionPending ? <Spinner data-icon="inline-start" /> : null}
              실행
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function PrecomputeMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value.toLocaleString("ko-KR")}</p>
    </div>
  )
}

function formatDateTime(value: string | null): string {
  if (!value) return "없음"
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value))
}

type PaginationItemValue = number | "start-ellipsis" | "end-ellipsis"

function buildPaginationItems(
  currentPage: number,
  pageCount: number,
): PaginationItemValue[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const items: PaginationItemValue[] = [1]
  const windowStart = Math.max(2, currentPage - 1)
  const windowEnd = Math.min(pageCount - 1, currentPage + 1)

  if (windowStart > 2) items.push("start-ellipsis")
  for (let page = windowStart; page <= windowEnd; page += 1) {
    items.push(page)
  }
  if (windowEnd < pageCount - 1) items.push("end-ellipsis")
  items.push(pageCount)

  return items
}
