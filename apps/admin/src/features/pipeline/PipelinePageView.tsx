"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"

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
import { PipelineNoticeSheet } from "./PipelineNoticeSheet"
import { PipelineQueue } from "./PipelineQueue"
import {
  PIPELINE_LENSES,
  PIPELINE_LENS_LABELS,
  PIPELINE_SOURCES,
  PIPELINE_SOURCE_LABELS,
  isPipelineBucket,
  isPipelineLens,
  isPipelineSource,
  type PipelineBucket,
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
}

export function PipelinePageView({
  initialSummary,
  initialNotices,
  query,
}: PipelinePageViewProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState(initialSummary)
  const [selectedNotice, setSelectedNotice] = useState<PipelineNoticeItem | null>(null)
  const [searchText, setSearchText] = useState(query.q)
  const [isPending, startTransition] = useTransition()

  useEffect(() => setSummary(initialSummary), [initialSummary])
  useEffect(() => setSearchText(query.q), [query.q])

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
            onOpen={setSelectedNotice}
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
        onClose={() => setSelectedNotice(null)}
      />
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
