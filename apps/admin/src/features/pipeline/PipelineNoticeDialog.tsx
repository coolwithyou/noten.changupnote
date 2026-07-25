"use client"

import { useEffect, useState } from "react"
import {
  CheckCheckIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
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
  PIPELINE_ACTION_LABELS,
  PIPELINE_CRITERION_DIMENSIONS,
  PIPELINE_SOURCE_LABELS,
  PIPELINE_STATUS_LABELS,
  type PipelineAction,
  type PipelineActionTarget,
  type PipelineCriterionDetail,
  type PipelineNoticeDetail,
  type PipelineNoticeItem,
} from "./contract"

interface PipelineNoticeDialogProps {
  notice: PipelineNoticeItem | null
  canMutate: boolean
  canReconvert: boolean
  refreshToken: number
  onClose: () => void
  onRequestAction: (action: PipelineAction, targets: PipelineActionTarget[]) => void
}

export function PipelineNoticeDialog({
  notice,
  canMutate,
  canReconvert,
  refreshToken,
  onClose,
  onRequestAction,
}: PipelineNoticeDialogProps) {
  const [detail, setDetail] = useState<PipelineNoticeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!notice) {
      setDetail(null)
      setError(null)
      return
    }

    const controller = new AbortController()
    setDetail(null)
    setError(null)
    setCopied(false)
    void fetch(
      `/api/admin/notice-pipeline/notices/${encodeURIComponent(notice.source)}/${encodeURIComponent(notice.sourceId)}`,
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
  }, [notice, refreshToken])

  const target = notice
    ? { source: notice.source, sourceId: notice.sourceId }
    : null

  return (
    <Dialog open={Boolean(notice)} onOpenChange={(open) => {
      if (!open) onClose()
    }}>
      <DialogContent
        data-testid="pipeline-notice-dialog"
        className="flex h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-7xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(92dvh,960px)] sm:max-w-7xl"
      >
        <DialogHeader className="shrink-0 gap-3 px-5 py-4 pr-14 sm:px-6 sm:py-5 sm:pr-16">
          <div className="flex flex-wrap items-center gap-2">
            {notice ? <Badge variant="outline">{PIPELINE_SOURCE_LABELS[notice.source]}</Badge> : null}
            {notice ? <Badge variant="secondary">{MANAGEMENT_STATE_LABELS[notice.managementState]}</Badge> : null}
            {notice?.pipelineStatus ? (
              <Badge variant="outline">{PIPELINE_STATUS_LABELS[notice.pipelineStatus]}</Badge>
            ) : null}
          </div>
          <DialogTitle className="text-lg leading-snug sm:text-xl">
            {notice?.title ?? "공고 상세"}
          </DialogTitle>
          <DialogDescription>
            {notice ? (
              <span className="flex flex-wrap items-center gap-2">
                <span>{notice.agency ?? "기관 미상"} · {formatDeadline(notice.dDay)}</span>
                <Button
                  aria-label="sourceId 복사"
                  className="h-6 px-1.5"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(notice.sourceId)
                      .then(() => {
                        setCopied(true)
                        toast.success("sourceId를 복사했습니다.")
                        window.setTimeout(() => setCopied(false), 1500)
                      })
                      .catch(() => toast.error("sourceId를 복사하지 못했습니다."))
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {notice.sourceId}
                </Button>
              </span>
            ) : "공고의 criteria, 첨부와 처리 이력을 확인합니다."}
          </DialogDescription>
        </DialogHeader>
        <Separator />

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>상세 로드 실패</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : detail ? (
            <NoticeDetailTabs
              detail={detail}
              canMutate={canMutate}
              canReconvert={canReconvert}
              onRequestAction={onRequestAction}
            />
          ) : (
            <DetailSkeleton />
          )}
        </div>

        {notice && target ? (
          <>
            <Separator />
            <DialogFooter className="mx-0 mb-0 shrink-0 flex-row flex-wrap items-center justify-between rounded-none border-0 bg-background/95 px-5 py-4 backdrop-blur sm:px-6 sm:justify-between">
              <span className="text-xs text-muted-foreground">
                j/k 다음 공고 · Enter 닫기 · a 검수 완료 · r 재변환
              </span>
              <div className="flex flex-wrap gap-2">
                {notice.needsReviewCount > 0 || notice.managementState === "needs_admin" ? (
                  <Button
                    disabled={!canMutate}
                    onClick={() => onRequestAction("mark_reviewed", [target])}
                  >
                    <CheckCheckIcon data-icon="inline-start" />
                    검수 완료
                  </Button>
                ) : (
                  <Button
                    disabled={!canMutate || !canReconvert || notice.attachmentCount === 0}
                    title={!canReconvert ? "변환 서버 연결 환경변수가 필요합니다." : undefined}
                    onClick={() => onRequestAction("reconvert", [target])}
                  >
                    <RotateCcwIcon data-icon="inline-start" />
                    재변환 요청
                  </Button>
                )}
              </div>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function NoticeDetailTabs({
  detail,
  canMutate,
  canReconvert,
  onRequestAction,
}: {
  detail: PipelineNoticeDetail
  canMutate: boolean
  canReconvert: boolean
  onRequestAction: (action: PipelineAction, targets: PipelineActionTarget[]) => void
}) {
  return (
    <Tabs defaultValue="criteria">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="criteria">22축 기대값</TabsTrigger>
        <TabsTrigger value="attachments">첨부·변환</TabsTrigger>
        <TabsTrigger value="demo">데모</TabsTrigger>
        <TabsTrigger value="history">이력</TabsTrigger>
      </TabsList>
      <TabsContent value="criteria" className="pt-4">
        <CriteriaTable
          detail={detail}
          canMutate={canMutate}
          onRequestAction={onRequestAction}
        />
      </TabsContent>
      <TabsContent value="attachments" className="pt-4">
        <AttachmentPanel
          detail={detail}
          canMutate={canMutate}
          canReconvert={canReconvert}
          onRequestAction={onRequestAction}
        />
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

function CriteriaTable({
  detail,
  canMutate,
  onRequestAction,
}: {
  detail: PipelineNoticeDetail
  canMutate: boolean
  onRequestAction: (action: PipelineAction, targets: PipelineActionTarget[]) => void
}) {
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
    <div className="overflow-x-auto rounded-xl border">
      <Table className="min-w-[1060px]">
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
                    <Button
                      disabled={!canMutate}
                      size="sm"
                      variant="outline"
                      onClick={() => onRequestAction("mark_reviewed", [{
                        source: detail.notice.source,
                        sourceId: detail.notice.sourceId,
                      }])}
                    >
                      <CheckCheckIcon data-icon="inline-start" />
                      검수 완료
                    </Button>
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

function AttachmentPanel({
  detail,
  canMutate,
  canReconvert,
  onRequestAction,
}: {
  detail: PipelineNoticeDetail
  canMutate: boolean
  canReconvert: boolean
  onRequestAction: (action: PipelineAction, targets: PipelineActionTarget[]) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>첨부 아카이브</CardTitle>
          <CardDescription>
            {detail.attachments.length.toLocaleString("ko-KR")}개 파일의 변환 상태입니다.
          </CardDescription>
          <CardAction>
            <Button
              disabled={!canMutate || !canReconvert || detail.attachments.length === 0}
              size="sm"
              title={!canReconvert ? "변환 서버 연결 환경변수가 필요합니다." : undefined}
              variant="outline"
              onClick={() => onRequestAction("reconvert", [{
                source: detail.notice.source,
                sourceId: detail.notice.sourceId,
                attachmentIds: detail.attachments.map((attachment) => attachment.id),
              }])}
            >
              <RotateCcwIcon data-icon="inline-start" />
              전체 재변환
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-xl border">
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow>
                  <TableHead>파일명</TableHead>
                  <TableHead>형식</TableHead>
                  <TableHead>크기</TableHead>
                  <TableHead>변환</TableHead>
                  <TableHead>Markdown</TableHead>
                  <TableHead>액션</TableHead>
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
                    <TableCell>
                      <Button
                        aria-label={`${attachment.filename} 재변환`}
                        disabled={!canMutate || !canReconvert}
                        size="sm"
                        title={!canReconvert ? "변환 서버 연결 환경변수가 필요합니다." : undefined}
                        variant="ghost"
                        onClick={() => onRequestAction("reconvert", [{
                          source: detail.notice.source,
                          sourceId: detail.notice.sourceId,
                          attachmentIds: [attachment.id],
                        }])}
                      >
                        <RotateCcwIcon data-icon="inline-start" />
                        재변환
                      </Button>
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
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
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <VersionField label="수집 시각" value={formatOptionalDateTime(detail.notice.collectedAt)} />
          <VersionField label="Parser" value={detail.notice.parserVersion} />
          <VersionField label="Model" value={detail.notice.modelVer} />
          <VersionField label="Prompt" value={detail.notice.promptVer} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>변환·골든셋</CardTitle>
          <CardDescription>첨부 변환 시각과 extraction golden 승격 여부입니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {detail.attachments
              .filter((attachment) => attachment.convertedAt)
              .map((attachment) => (
                <Badge key={attachment.id} variant="outline">
                  {attachment.filename} · {formatOptionalDateTime(attachment.convertedAt)}
                </Badge>
              ))}
            {detail.attachments.every((attachment) => !attachment.convertedAt) ? (
              <span className="text-sm text-muted-foreground">기록된 변환 완료 시각이 없습니다.</span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {detail.goldenSet.length > 0 ? detail.goldenSet.map((golden) => (
              <Badge key={golden.id} variant="secondary">
                golden_set · {golden.goldenVer}
              </Badge>
            )) : (
              <Badge variant="outline">golden_set 미승격</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>관리자 액션</CardTitle>
          <CardDescription>admin_users 주체로 남긴 검수·재변환 감사 이력입니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {detail.adminActions.length > 0 ? detail.adminActions.map((action) => (
            <div
              key={action.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p className="font-medium">{PIPELINE_ACTION_LABELS[action.action]}</p>
                <p className="text-xs text-muted-foreground">
                  {action.actorEmail} · {formatDateTime(action.createdAt)}
                </p>
                {action.error ? <p className="mt-1 text-xs text-destructive">{action.error}</p> : null}
              </div>
              <Badge variant={action.status === "failed" ? "destructive" : "outline"}>
                {action.status}
              </Badge>
            </div>
          )) : (
            <span className="text-sm text-muted-foreground">관리자 액션 이력이 없습니다.</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>추출 이력</CardTitle>
          <CardDescription>최신 50건의 extraction_log입니다.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto rounded-xl border">
            <Table className="min-w-[760px]">
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
        </CardContent>
      </Card>
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

function formatOptionalDateTime(value: string | null): string {
  return value ? formatDateTime(value) : "없음"
}

function uniqueLabels(values: Array<string | null>): string {
  const labels = [...new Set(values.filter((value): value is string => Boolean(value)))]
  return labels.length > 0 ? labels.join(" · ") : "—"
}
