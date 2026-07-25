"use client"

import { useState, useTransition } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  RefreshCwIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
} from "lucide-react"

import {
  DEEP_PIPELINE_BUCKET_LABELS,
  type DeepPipelineAction,
  type DeepPipelineNoticeDetail,
} from "@/features/pipeline/contract"
import { DeepAxisGrid } from "@/features/pipeline/DeepAxisGrid"
import type { AdminRole } from "@/lib/server/auth/adminUsers"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function DeepNoticeSheet({
  detail,
  loading,
  open,
  role,
  onOpenChange,
  onRefresh,
}: {
  detail: DeepPipelineNoticeDetail | null
  loading: boolean
  open: boolean
  role: AdminRole
  onOpenChange: (open: boolean) => void
  onRefresh: () => Promise<void>
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const runAction = (
    action: DeepPipelineAction,
    target: { exceptionKey?: string },
  ) => {
    if (!detail) return
    const notice = detail.notice
    const costLine = action === "requeue_job"
      ? `대상 1공고 · 입력 ${formatNumber(notice.inputChars)}자 · 직전 비용 ${formatCost(notice.costUsd)} · 모델 ${notice.model ?? "policy allowlist"}`
      : `대상 1개 예외 · ${target.exceptionKey ?? ""}`
    const confirmed = window.confirm(
      `${actionLabel(action)}\n\n${costLine}\n\n단계 상태는 검증 receipt만 변경할 수 있으며 이 액션으로 passed 처리되지 않습니다.`,
    )
    if (!confirmed) return
    setMessage(null)
    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/pipeline/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            action,
            grantId: notice.grantId,
            jobId: action === "requeue_job" ? notice.jobId : undefined,
            runId: action === "requeue_job" ? undefined : notice.runId,
            exceptionKey: target.exceptionKey,
          }),
        })
        const payload = await response.json() as {
          error?: { message?: string }
        }
        if (!response.ok) {
          throw new Error(payload.error?.message ?? "관제 액션에 실패했습니다.")
        }
        setMessage(`${actionLabel(action)} 요청을 기록했습니다.`)
        await onRefresh()
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "관제 액션에 실패했습니다.")
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-hidden sm:max-w-5xl">
        <SheetHeader className="border-b">
          <SheetTitle>{detail?.notice.title ?? "딥분석 증적"}</SheetTitle>
          <SheetDescription>
            {detail
              ? `${detail.notice.source}/${detail.notice.sourceId} · ${DEEP_PIPELINE_BUCKET_LABELS[detail.notice.bucket]}`
              : "최신 job/run과 append-only receipt를 불러오는 중입니다."}
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            증적을 불러오는 중…
          </div>
        ) : detail ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-popover py-3">
              <Badge variant={detail.notice.bucket === "blocked_or_failed" ? "destructive" : "secondary"}>
                {DEEP_PIPELINE_BUCKET_LABELS[detail.notice.bucket]}
              </Badge>
              <Badge variant="outline">job {detail.notice.jobStatus ?? "없음"}</Badge>
              <Badge variant="outline">run {detail.notice.runStatus ?? "없음"}</Badge>
              {detail.notice.firstBlockingStage ? (
                <Badge variant="destructive">첫 blocker {detail.notice.firstBlockingStage}</Badge>
              ) : null}
              {detail.notice.url ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={detail.notice.url} target="_blank" rel="noreferrer" />}
                >
                  원문 <ExternalLinkIcon />
                </Button>
              ) : null}
              {(role === "admin" || role === "owner")
                && detail.notice.jobId
                && ["blocked", "dead_letter", "retry_wait", "pending_budget"].includes(detail.notice.jobStatus ?? "") ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => runAction("requeue_job", {})}
                  >
                    <RefreshCwIcon /> 딥분석 재처리
                  </Button>
                ) : null}
            </div>

            {message ? (
              <p className="my-3 rounded-lg border bg-muted p-3 text-sm">{message}</p>
            ) : null}

            <Tabs defaultValue="stages" className="pt-4">
              <TabsList className="max-w-full overflow-x-auto">
                <TabsTrigger value="stages">단계 증적</TabsTrigger>
                <TabsTrigger value="attachments">원문·첨부</TabsTrigger>
                <TabsTrigger value="axes">22축 결과</TabsTrigger>
                <TabsTrigger value="audit">독립 감사</TabsTrigger>
                <TabsTrigger value="publication">승격·서빙</TabsTrigger>
                <TabsTrigger value="history">예외·이력</TabsTrigger>
              </TabsList>

              <TabsContent value="stages" className="pt-3">
                <div className="grid gap-2">
                  {detail.receipts.length === 0 ? <Empty>stage receipt가 없습니다.</Empty> : null}
                  {detail.receipts.map((receipt) => (
                    <article key={receipt.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {receipt.status === "passed"
                          ? <CheckCircle2Icon className="text-primary" />
                          : <AlertTriangleIcon className="text-destructive" />}
                        <strong>{receipt.label}</strong>
                        <Badge variant={receipt.status === "passed" ? "secondary" : "destructive"}>
                          {receipt.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {receipt.verifierVersion} · attempt {receipt.attempt} · {formatDate(receipt.createdAt)}
                        </span>
                      </div>
                      <HashLine label="evidence" value={receipt.evidenceSha256} />
                      {receipt.artifactKey ? <HashLine label="artifact" value={receipt.artifactKey} /> : null}
                      <JsonBlock value={receipt.evidence} />
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="attachments" className="pt-3">
                <div className="rounded-lg border p-3">
                  <HashLine label="source revision" value={detail.sourceRevisionSha256} />
                  <HashLine label="attachment manifest" value={detail.attachmentManifestSha256} />
                  <HashLine label="input" value={detail.inputSha256} />
                  <HashLine label="input artifact" value={detail.inputArtifactKey} />
                </div>
                <div className="grid gap-2 pt-3">
                  {detail.attachments.length === 0 ? <Empty>등록된 첨부가 없습니다.</Empty> : null}
                  {detail.attachments.map((attachment) => (
                    <article key={attachment.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="min-w-0 break-all">{attachment.filename}</strong>
                        <Badge
                          variant={attachment.conversionStatus === "failed" ? "destructive" : "outline"}
                        >
                          {attachment.conversionStatus ?? "미변환"}
                        </Badge>
                      </div>
                      <HashLine label="원본 sha256" value={attachment.sha256} />
                      <HashLine label="원본 R2" value={attachment.storageKey} />
                      <HashLine label="markdown sha256" value={attachment.markdownSha256} />
                      <HashLine label="markdown R2" value={attachment.markdownStorageKey} />
                      {attachment.conversionError ? (
                        <p className="mt-2 text-sm text-destructive">{attachment.conversionError}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="axes" className="pt-3">
                <DeepAxisGrid axes={detail.axes} />
                <div className="grid gap-2 pt-4 md:grid-cols-2">
                  {detail.axes.map((axis) => (
                    <article key={axis.dimension} className="rounded-lg border p-3">
                      <div className="flex items-center gap-2">
                        <strong>{axis.label}</strong>
                        <Badge variant={axis.status === "input_missing" ? "destructive" : "outline"}>
                          {axis.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {Math.round(axis.confidence * 100)}%
                        </span>
                      </div>
                      {axis.comment ? <p className="mt-2 text-sm">{axis.comment}</p> : null}
                      {axis.evidenceRefs.length > 0 ? <JsonBlock value={axis.evidenceRefs} /> : null}
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="audit" className="pt-3">
                <div className="grid gap-2">
                  {detail.audits.length === 0 ? <Empty>독립 감사 결과가 없습니다.</Empty> : null}
                  {detail.audits.map((audit) => (
                    <article key={audit.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{audit.model}</strong>
                        <Badge variant={audit.verdict === "concur" ? "secondary" : "destructive"}>
                          {audit.verdict}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {audit.promptVersion} · attempt {audit.attempt}
                        </span>
                      </div>
                      <HashLine label="artifact" value={audit.artifactSha256} />
                      <JsonBlock value={audit.itemResults} />
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="publication" className="pt-3">
                <div className="rounded-lg border p-3">
                  <HashLine label="output artifact" value={detail.outputArtifactKey} />
                  <HashLine label="raw response artifact" value={detail.rawResponseArtifactKey} />
                  {detail.errorCode ? (
                    <p className="mt-2 text-sm text-destructive">
                      {detail.errorCode}: {detail.errorMessage}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-2 pt-3">
                  {detail.promotions.length === 0 ? <Empty>승격 릴리스 항목이 없습니다.</Empty> : null}
                  {detail.promotions.map((promotion) => (
                    <article key={promotion.itemId} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{promotion.releaseId}</strong>
                        <Badge variant="outline">{promotion.releaseStatus}</Badge>
                        <Badge variant="outline">{promotion.itemStatus}</Badge>
                      </div>
                      <HashLine label="plan" value={promotion.planSha256} />
                      <HashLine label="before" value={promotion.beforeSha256} />
                      <HashLine label="after" value={promotion.afterSha256} />
                    </article>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="history" className="pt-3">
                <div className="grid gap-2">
                  {detail.exceptions.map((exception) => (
                    <article key={exception.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{exception.reasonCode}</strong>
                        <Badge variant={exception.current ? "destructive" : "outline"}>
                          {exception.eventType}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {exception.actor} · {formatDate(exception.createdAt)}
                        </span>
                        {exception.current
                          && !["resolved", "assigned"].includes(exception.eventType)
                          && ["reviewer", "admin", "owner"].includes(role) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isPending}
                              onClick={() => runAction("claim_exception", {
                                exceptionKey: exception.exceptionKey,
                              })}
                            >
                              <UserRoundCheckIcon /> 내게 배정
                            </Button>
                          ) : null}
                        {exception.current && exception.eventType === "assigned" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={() => runAction("release_exception", {
                              exceptionKey: exception.exceptionKey,
                            })}
                          >
                            <UserRoundXIcon /> 배정 해제
                          </Button>
                        ) : null}
                      </div>
                      <HashLine label="exception key" value={exception.exceptionKey} />
                      <JsonBlock value={exception.detail} />
                    </article>
                  ))}
                  {detail.exceptions.length === 0 ? <Empty>예외 이벤트가 없습니다.</Empty> : null}
                </div>
                <div className="grid gap-2 pt-4">
                  <h3 className="font-medium">관리자 액션 감사</h3>
                  {detail.adminActions.map((action) => (
                    <article key={action.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{actionLabel(action.action)}</strong>
                        <Badge variant={action.outcome === "succeeded" ? "secondary" : "destructive"}>
                          {action.outcome}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {action.actorEmail} · {formatDate(action.createdAt)}
                        </span>
                      </div>
                      {action.error ? <p className="mt-2 text-destructive">{action.error}</p> : null}
                    </article>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-destructive">
            증적을 불러오지 못했습니다.
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function HashLine({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="mt-2 min-w-0 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>{" "}
      <code className="break-all">{value ?? "없음"}</code>
    </p>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">{children}</p>
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value))
}

function formatNumber(value: number | null): string {
  return value === null ? "미상" : new Intl.NumberFormat("ko-KR").format(value)
}

function formatCost(value: number | null): string {
  return value === null ? "미상" : `$${value.toFixed(4)}`
}

function actionLabel(action: DeepPipelineAction): string {
  if (action === "requeue_job") return "딥분석 재처리"
  if (action === "claim_exception") return "예외 배정"
  return "예외 배정 해제"
}
