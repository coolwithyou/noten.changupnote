"use client"

import { useEffect, useState } from "react"
import {
  ExternalLinkIcon,
  FileTextIcon,
  LoaderCircleIcon,
} from "lucide-react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  CRITERION_DIMENSION_LABELS,
  MANAGEMENT_STATE_LABELS,
  PIPELINE_CRITERION_DIMENSIONS,
  PIPELINE_SOURCE_LABELS,
  PIPELINE_STATUS_LABELS,
  type PipelineCriterionDetail,
  type PipelineNoticeDetail,
  type PipelineNoticeItem,
} from "./contract"

interface PipelineNoticeSheetProps {
  notice: PipelineNoticeItem | null
  onClose: () => void
}

export function PipelineNoticeSheet({
  notice,
  onClose,
}: PipelineNoticeSheetProps) {
  const [detail, setDetail] = useState<PipelineNoticeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) {
      setDetail(null)
      setError(null)
      return
    }

    const controller = new AbortController()
    setDetail(null)
    setError(null)
    void fetch(
      `/api/admin/pipeline/notices/${encodeURIComponent(notice.source)}/${encodeURIComponent(notice.sourceId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json() as {
          data?: PipelineNoticeDetail
          error?: { message?: string }
        }
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "공고 상세를 불러오지 못했습니다.")
        }
        setDetail(body.data)
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return
        setError(fetchError instanceof Error ? fetchError.message : "공고 상세를 불러오지 못했습니다.")
      })

    return () => controller.abort()
  }, [notice])

  return (
    <Sheet open={Boolean(notice)} onOpenChange={(open) => {
      if (!open) onClose()
    }}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            {notice ? <Badge variant="outline">{PIPELINE_SOURCE_LABELS[notice.source]}</Badge> : null}
            {notice ? <Badge variant="secondary">{MANAGEMENT_STATE_LABELS[notice.managementState]}</Badge> : null}
            {notice?.pipelineStatus ? (
              <Badge variant="outline">{PIPELINE_STATUS_LABELS[notice.pipelineStatus]}</Badge>
            ) : null}
          </div>
          <SheetTitle>{notice?.title ?? "공고 상세"}</SheetTitle>
          <SheetDescription>
            {notice
              ? `${notice.agency ?? "기관 미상"} · ${formatDeadline(notice.dDay)} · ${notice.sourceId}`
              : "공고의 criteria, 첨부와 처리 이력을 확인합니다."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>상세 로드 실패</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : detail ? (
            <NoticeDetailTabs detail={detail} />
          ) : (
            <DetailSkeleton />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function NoticeDetailTabs({ detail }: { detail: PipelineNoticeDetail }) {
  return (
    <Tabs defaultValue="criteria">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="criteria">22축 기대값</TabsTrigger>
        <TabsTrigger value="attachments">첨부·변환</TabsTrigger>
        <TabsTrigger value="demo">데모</TabsTrigger>
        <TabsTrigger value="history">이력</TabsTrigger>
      </TabsList>
      <TabsContent value="criteria" className="pt-4">
        <CriteriaTable detail={detail} />
      </TabsContent>
      <TabsContent value="attachments" className="pt-4">
        <AttachmentPanel detail={detail} />
      </TabsContent>
      <TabsContent value="demo" className="pt-4">
        <DemoPanel detail={detail} />
      </TabsContent>
      <TabsContent value="history" className="pt-4">
        <HistoryPanel detail={detail} />
      </TabsContent>
    </Tabs>
  )
}

function CriteriaTable({ detail }: { detail: PipelineNoticeDetail }) {
  const byDimension = new Map<
    PipelineCriterionDetail["dimension"],
    PipelineCriterionDetail[]
  >()
  for (const criterion of detail.criteria) {
    const grouped = byDimension.get(criterion.dimension) ?? []
    grouped.push(criterion)
    byDimension.set(criterion.dimension, grouped)
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>축</TableHead>
            <TableHead>종류</TableHead>
            <TableHead>연산자</TableHead>
            <TableHead>기대값</TableHead>
            <TableHead>확신도</TableHead>
            <TableHead>근거 원문</TableHead>
            <TableHead>검수</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PIPELINE_CRITERION_DIMENSIONS.map((dimension) => {
            const criteria = byDimension.get(dimension) ?? []
            const needsReview = criteria.some((criterion) => criterion.needsReview)
            return (
              <TableRow key={dimension} data-state={needsReview ? "selected" : undefined}>
                <TableCell className="font-medium">
                  {CRITERION_DIMENSION_LABELS[dimension]}
                </TableCell>
                <TableCell>{uniqueLabels(criteria.map((criterion) => criterion.kind))}</TableCell>
                <TableCell>{uniqueLabels(criteria.map((criterion) => criterion.operator))}</TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  {criteria.length > 0
                    ? criteria.map((criterion) => (
                        <p key={criterion.id}>{criterion.valueLabel}</p>
                      ))
                    : "공란"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {criteria.length > 0
                    ? criteria
                        .map((criterion) => `${Math.round(criterion.confidence * 100)}%`)
                        .join(", ")
                    : "—"}
                </TableCell>
                <TableCell className="max-w-72 whitespace-normal text-muted-foreground">
                  {uniqueLabels(
                    criteria.map((criterion) => criterion.rawText ?? criterion.sourceSpan),
                  )}
                </TableCell>
                <TableCell>
                  {needsReview ? (
                    <Badge variant="destructive">필요</Badge>
                  ) : criteria.length > 0 ? (
                    <Badge variant="secondary">없음</Badge>
                  ) : (
                    <Badge variant="outline">공란</Badge>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function AttachmentPanel({ detail }: { detail: PipelineNoticeDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>첨부 아카이브</CardTitle>
          <CardDescription>
            {detail.attachments.length.toLocaleString("ko-KR")}개 파일의 변환 상태입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>파일명</TableHead>
                  <TableHead>형식</TableHead>
                  <TableHead>크기</TableHead>
                  <TableHead>변환</TableHead>
                  <TableHead>Markdown</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.attachments.length > 0 ? detail.attachments.map((attachment) => (
                  <TableRow key={attachment.id}>
                    <TableCell className="max-w-64 truncate font-medium">
                      {attachment.filename}
                    </TableCell>
                    <TableCell>{attachment.contentType ?? "미상"}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(attachment.bytes)}</TableCell>
                    <TableCell>
                      <Badge variant={attachment.conversionStatus === "failed" ? "destructive" : "outline"}>
                        {attachment.conversionStatus ?? "미처리"}
                      </Badge>
                      {attachment.conversionError ? (
                        <p className="mt-1 max-w-72 text-xs text-destructive">
                          {attachment.conversionError}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {attachment.markdownUrl ? (
                        <Button
                          render={
                            <a
                              href={attachment.markdownUrl}
                              target="_blank"
                              rel="noreferrer"
                            />
                          }
                          nativeButton={false}
                          size="sm"
                          variant="link"
                        >
                          <FileTextIcon data-icon="inline-start" />
                          열기
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">없음</span>
                      )}
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      보관된 첨부가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>지원서 Surface</CardTitle>
          <CardDescription>
            추출 가능한 양식과 현재 필드 준비 상태입니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {detail.surfaces.length > 0 ? detail.surfaces.map((surface) => (
            <div
              key={surface.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{surface.title}</p>
                <p className="text-xs text-muted-foreground">
                  {surface.type} · {surface.format} · {formatDateTime(surface.updatedAt)}
                </p>
              </div>
              <Badge variant={surface.extractionStatus === "failed" ? "destructive" : "secondary"}>
                {surface.extractionStatus}
              </Badge>
            </div>
          )) : (
            <Alert>
              <AlertTitle>Surface 없음</AlertTitle>
              <AlertDescription>이 공고에는 아직 지원서 surface가 연결되지 않았습니다.</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DemoPanel({ detail }: { detail: PipelineNoticeDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>사용자 노출 확인</CardTitle>
        <CardDescription>
          iframe 없이 사용자향 공고 상세와 원문을 새 탭에서 확인합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          render={<a href={detail.notice.demoHref} target="_blank" rel="noreferrer" />}
          nativeButton={false}
        >
          사용자 공고 상세
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
        {detail.notice.url ? (
          <Button
            render={<a href={detail.notice.url} target="_blank" rel="noreferrer" />}
            nativeButton={false}
            variant="outline"
          >
            원문 공고
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HistoryPanel({ detail }: { detail: PipelineNoticeDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>현재 버전</CardTitle>
          <CardDescription>공고 정본에 기록된 parser/model/prompt 버전입니다.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <VersionField label="Parser" value={detail.notice.parserVersion} />
          <VersionField label="Model" value={detail.notice.modelVer} />
          <VersionField label="Prompt" value={detail.notice.promptVer} />
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>시각</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>확신도</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Prompt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.history.length > 0 ? detail.history.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{formatDateTime(entry.at)}</TableCell>
                <TableCell><Badge variant="outline">{entry.status}</Badge></TableCell>
                <TableCell className="tabular-nums">{Math.round(entry.confidence * 100)}%</TableCell>
                <TableCell>{entry.modelVer}</TableCell>
                <TableCell>{entry.promptVer}</TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  추출 이력이 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="공고 상세 불러오는 중">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="animate-spin" />
        상세 데이터를 불러오고 있습니다.
      </div>
      <Skeleton className="h-8 w-80" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function VersionField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-medium">{value ?? "미상"}</p>
    </div>
  )
}

function formatDeadline(value: number | null): string {
  if (value === null) return "마감 미상"
  if (value === 0) return "오늘 마감"
  return value > 0 ? `D-${value}` : `마감 ${Math.abs(value)}일 경과`
}

function formatBytes(value: number | null): string {
  if (value === null) return "미상"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value))
}

function uniqueLabels(values: Array<string | null>): string {
  const labels = [...new Set(values.filter((value): value is string => Boolean(value)))]
  return labels.length > 0 ? labels.join(" · ") : "—"
}
