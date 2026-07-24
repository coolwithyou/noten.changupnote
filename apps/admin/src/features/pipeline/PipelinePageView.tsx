"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { toast } from "sonner"

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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { PipelineCanvas } from "./PipelineCanvas"
import { PipelineNoticeSheet } from "./PipelineNoticeSheet"
import { PipelineQueue } from "./PipelineQueue"
import {
  PIPELINE_ACTION_LABELS,
  PIPELINE_LENSES,
  PIPELINE_LENS_LABELS,
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
        const response = await fetch(`/api/admin/pipeline/summary?${params.toString()}`, {
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

  const pushQuery = useCallback((patch: Record<string, string | null>, resetCursor = true) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") params.delete(key)
      else params.set(key, value)
    }
    if (resetCursor) params.delete("cursor")
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`)
    })
  }, [pathname, router, searchParams])

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
      const response = await fetch("/api/admin/pipeline/actions", {
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
        throw new Error(body.error?.message ?? "공고 관제 액션을 처리하지 못했습니다.")
      }
      const { totals } = body.data
      const message = pendingAction.action === "mark_reviewed"
        ? `${totals.succeeded}건 검수 완료 · criteria ${totals.affected}건 갱신`
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
      toast.error(error instanceof Error ? error.message : "공고 관제 액션을 처리하지 못했습니다.")
    } finally {
      setIsActionPending(false)
    }
  }, [isActionPending, pendingAction, router])

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-2xl font-semibold tracking-tight">공고 관제</h2>
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
          파이프라인 건강 상태를 집계로 보고, 확인할 공고는 50건 단위 큐에서 연속 검수합니다.
        </p>
      </section>

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

      <Card>
        <CardHeader>
          <CardTitle>트리아지 큐</CardTitle>
          <CardDescription>
            {initialNotices.total.toLocaleString("ko-KR")}건 · 50건 단위 · D-day 기준
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              pushQuery({ q: searchText.trim() })
            }}
          >
            <FieldGroup>
              <Field orientation="responsive">
                <FieldLabel className="sr-only" htmlFor="pipeline-search">
                  공고 검색
                </FieldLabel>
                <Input
                  id="pipeline-search"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="공고명, 기관, sourceId 검색"
                />
                <Button type="submit">
                  <SearchIcon data-icon="inline-start" />
                  검색
                </Button>
              </Field>
            </FieldGroup>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Field orientation="horizontal" className="w-auto">
              <FieldTitle>소스</FieldTitle>
              <ToggleGroup
                value={[query.source ?? "all"]}
                variant="outline"
                onValueChange={(values) => {
                  const value = values[0]
                  if (!value) return
                  changeSource(isPipelineSource(value) ? value : null)
                }}
              >
                <ToggleGroupItem value="all">전체</ToggleGroupItem>
                {PIPELINE_SOURCES.map((source) => (
                  <ToggleGroupItem key={source} value={source}>
                    {PIPELINE_SOURCE_LABELS[source]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>

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
          </div>

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

          <div className="flex items-center justify-between gap-3">
            <Button
              disabled={!query.cursor}
              variant="outline"
              onClick={() => pushQuery({ cursor: null }, false)}
            >
              첫 페이지
            </Button>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(initialNotices.generatedAt)} 기준
            </span>
            <Button
              disabled={!initialNotices.hasMore || !initialNotices.cursor}
              onClick={() => {
                if (initialNotices.cursor) {
                  pushQuery({ cursor: initialNotices.cursor }, false)
                }
              }}
            >
              다음 50건
            </Button>
          </div>
        </CardContent>
      </Card>

      <PipelineNoticeSheet
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
              {pendingAction ? PIPELINE_ACTION_LABELS[pendingAction.action] : "공고 관제 액션"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              선택한 {pendingAction?.targets.length.toLocaleString("ko-KR") ?? 0}건에
              {pendingAction?.action === "mark_reviewed"
                ? " 검수 완료 상태를 기록하고 추출 이력을 남깁니다."
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

function formatDateTime(value: string | null): string {
  if (!value) return "없음"
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value))
}
