"use client"

import { useState, useTransition } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  RefreshCwIcon,
  ScissorsIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
} from "lucide-react"

import {
  DEEP_PIPELINE_BUCKET_LABELS,
  DEEP_STAGE_LABELS,
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
    target: { exceptionKey?: string; aggregateSplitCaseId?: string },
  ) => {
    if (!detail) return
    const notice = detail.notice
    const costLine = action === "requeue_job"
      ? `대상 1공고 · 입력 ${formatNumber(notice.inputChars)}자 · 직전 비용 ${formatCost(notice.costUsd)} · 모델 ${notice.model ?? "policy allowlist"}`
      : action === "approve_aggregate_split"
        ? `대상 1개 통합공고 · 입력 ${formatNumber(detail.aggregateSplitCase?.inputChars ?? null)}자 · 상한 ${formatNumber(detail.aggregateSplitCase?.inputCapChars ?? null)}자 · ${formatNumber(detail.aggregateSplitCase?.chunkCount ?? null)}개 입력 조각 · 누적 비용 상한 ${formatCost(detail.aggregateSplitCase?.costCapUsd ?? null)}`
        : `대상 1개 예외 · ${target.exceptionKey ?? ""}`
    const consequence = action === "approve_aggregate_split"
      ? "승인하면 원문 전체를 보존한 별도 분리 작업 대기열로 이동합니다. 이 승인만으로 하위 공고가 발행되거나 매칭에 노출되지는 않습니다."
      : "단계 상태는 검증 receipt만 변경할 수 있으며 이 액션으로 passed 처리되지 않습니다."
    const confirmed = window.confirm(
      `${actionLabel(action)}\n\n${costLine}\n\n${consequence}`,
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
            runId: action === "claim_exception" || action === "release_exception"
              ? notice.runId
              : undefined,
            exceptionKey: target.exceptionKey,
            aggregateSplitCaseId: target.aggregateSplitCaseId,
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

            {detail.aggregateSplitCase ? (
              <section className="my-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangleIcon className="text-amber-700" />
                      <strong>통합공고 분리 필요</strong>
                      <Badge
                        variant={detail.aggregateSplitCase.status === "failed"
                          || detail.aggregateSplitCase.materializationStatus === "failed"
                          ? "destructive"
                          : "outline"}
                      >
                        {aggregateSplitStatusLabel(detail.aggregateSplitCase.status)}
                      </Badge>
                      {detail.aggregateSplitCase.status === "completed" ? (
                        <Badge
                          variant={detail.aggregateSplitCase.promotionStatus === "failed"
                            ? "destructive"
                            : "outline"}
                        >
                          {aggregateSplitPromotionStatusLabel(
                            detail.aggregateSplitCase.promotionStatus,
                          )}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm leading-6">
                      여러 하위사업이 섞인 대용량 통합공고입니다. 입력{" "}
                      {formatNumber(detail.aggregateSplitCase.inputChars)}자가 정책 상한{" "}
                      {formatNumber(detail.aggregateSplitCase.inputCapChars)}자를 넘어 일반
                      딥분석을 계속하지 않았습니다. 사람의 승인 뒤 하위 공고 분리 작업으로
                      넘겨야 합니다.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      입력 조각 {formatNumber(detail.aggregateSplitCase.chunkCount)}개 · 첨부{" "}
                      {formatNumber(detail.aggregateSplitCase.attachmentCount)}개 · 원문은 이
                      단계에서 변경되지 않음 · 분리 누적 비용 상한{" "}
                      {formatCost(detail.aggregateSplitCase.costCapUsd)}
                    </p>
                    {detail.aggregateSplitCase.status === "approved" ? (
                      <p className="mt-2 text-sm">
                        사람 승인이 완료되어 분리 worker 실행을 기다리고 있습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.status === "processing" ? (
                      <p className="mt-2 text-sm">
                        분리 worker가 원문 segment를 하위사업별로 분류하고 있습니다. lease{" "}
                        {detail.aggregateSplitCase.leaseExpiresAt
                          ? formatDate(detail.aggregateSplitCase.leaseExpiresAt)
                          : "미상"}까지
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.status === "completed" ? (
                      <p className="mt-2 text-sm">
                        하위사업 manifest {formatNumber(detail.aggregateSplitCase.programCount)}개를
                        검증했습니다. 파생 공고 후보{" "}
                        {formatNumber(detail.aggregateSplitCase.preparedChildCount)}개가 봉인됐습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.materializationStatus === "pending" ? (
                      <p className="mt-2 text-sm">
                        검증된 manifest를 다시 읽어 파생 공고 입력을 봉인할 worker를
                        기다리고 있습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.materializationStatus === "processing" ? (
                      <p className="mt-2 text-sm">
                        파생 공고 후보를 봉인하고 있습니다. lease{" "}
                        {detail.aggregateSplitCase.materializationLeaseExpiresAt
                          ? formatDate(
                            detail.aggregateSplitCase.materializationLeaseExpiresAt,
                          )
                          : "미상"}까지
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.materializationStatus === "prepared" ? (
                      <p className="mt-2 text-sm">
                        파생 공고 후보 전체가 봉인됐습니다. parent는 계속 노출되고 child는
                        최종 전환 전까지 매칭 분모에 포함되지 않습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.promotionStatus === "pending" ? (
                      <p className="mt-2 text-sm">
                        봉인된 child를 다시 검증해 staged 공고로 원자 생성할 작업을
                        기다리고 있습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.promotionStatus === "staged" ? (
                      <p className="mt-2 text-sm">
                        staged 공고 {formatNumber(detail.aggregateSplitCase.stagedChildCount)}개
                        생성 · 깊은 분석 enqueue{" "}
                        {formatNumber(detail.aggregateSplitCase.enqueuedChildCount)}/
                        {formatNumber(detail.aggregateSplitCase.stagedChildCount)}개. parent는
                        visible, child는 staged 상태입니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.promotionStatus === "enqueued" ? (
                      <p className="mt-2 text-sm">
                        staged child {formatNumber(detail.aggregateSplitCase.stagedChildCount)}개
                        전체를 기존 깊은 분석 → 독립 validator → AI 자동검수 경로에 직접
                        enqueue했습니다. 아직 사용자 매칭에는 노출되지 않습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.promotionStatus === "enqueued" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        S12 발행 완료{" "}
                        {detail.aggregateSplitCase.children.filter(
                          (child) => child.publicationFirstBlocker === null,
                        ).length}
                        /{detail.aggregateSplitCase.children.length} · 한 child라도 blocker가
                        남으면 case 전체 노출 전환을 진행하지 않습니다.
                      </p>
                    ) : null}
                    {detail.aggregateSplitCase.promotionStatus === "failed" ? (
                      <p className="mt-2 text-sm text-destructive">
                        child input/projection 재검증 또는 원자적 staged 생성이 실패해
                        아무 child도 노출하지 않았습니다.
                      </p>
                    ) : null}
                  </div>
                  {(role === "admin" || role === "owner")
                    && detail.aggregateSplitCase.status === "pending_review" ? (
                      <Button
                        disabled={isPending}
                        onClick={() => runAction("approve_aggregate_split", {
                          aggregateSplitCaseId: detail.aggregateSplitCase!.id,
                        })}
                      >
                        <ScissorsIcon /> 분리 처리 수락
                      </Button>
                    ) : null}
                </div>
                {detail.aggregateSplitCase.approvedAt ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {detail.aggregateSplitCase.approvedByEmail ?? "관리자"} 승인 ·{" "}
                    {formatDate(detail.aggregateSplitCase.approvedAt)} · 시도{" "}
                    {detail.aggregateSplitCase.attemptCount}/
                    {detail.aggregateSplitCase.maxAttempts} · 파생 준비 시도{" "}
                    {detail.aggregateSplitCase.materializationAttemptCount}/
                    {detail.aggregateSplitCase.materializationMaxAttempts}
                  </p>
                ) : null}
                {detail.aggregateSplitCase.inputSha256
                  || detail.aggregateSplitCase.manifestSha256
                  || detail.aggregateSplitCase.rawResponseSha256 ? (
                  <div className="mt-3 rounded-lg border bg-background/70 p-3">
                    <p className="text-xs text-muted-foreground">
                      {detail.aggregateSplitCase.model} ·{" "}
                      {detail.aggregateSplitCase.promptVersion} · segment{" "}
                      {formatNumber(detail.aggregateSplitCase.segmentCount)}개 · 외부 호출{" "}
                      {formatNumber(detail.aggregateSplitCase.externalCallsMade)}회 · token{" "}
                      {formatNumber(detail.aggregateSplitCase.inputTokens)}/
                      {formatNumber(detail.aggregateSplitCase.outputTokens)} · 비용{" "}
                      {formatCost(detail.aggregateSplitCase.costUsd)}
                    </p>
                    <HashLine
                      label="분리 input"
                      value={detail.aggregateSplitCase.inputSha256}
                    />
                    <HashLine
                      label="input R2"
                      value={detail.aggregateSplitCase.inputArtifactKey}
                    />
                    <HashLine
                      label="분리 manifest"
                      value={detail.aggregateSplitCase.manifestSha256}
                    />
                    <HashLine
                      label="manifest R2"
                      value={detail.aggregateSplitCase.manifestArtifactKey}
                    />
                    <HashLine
                      label="raw response"
                      value={detail.aggregateSplitCase.rawResponseSha256}
                    />
                    <HashLine
                      label="raw R2"
                      value={detail.aggregateSplitCase.rawResponseArtifactKey}
                    />
                  </div>
                ) : null}
                {detail.aggregateSplitCase.children.length > 0 ? (
                  <div className="mt-3 grid gap-2">
                    {detail.aggregateSplitCase.children.map((child) => (
                      <article key={child.id} className="rounded-lg border bg-background/70 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <strong className="text-sm">
                              {child.ordinal + 1}. {child.title}
                            </strong>
                            <p className="text-xs text-muted-foreground">
                              {child.agencyPrimary ?? "기관 미상"} · {child.sourceId}
                            </p>
                          </div>
                          <Badge
                            variant={aggregateSplitChildHasFailure(child)
                              ? "destructive"
                              : "outline"}
                          >
                            {aggregateSplitChildPipelineLabel(child)}
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          입력 {formatNumber(child.inputChars)}자 · 준비{" "}
                          {child.preparedAt ? formatDate(child.preparedAt) : "미완료"} · staged{" "}
                          {child.stagedGrantAt ? formatDate(child.stagedGrantAt) : "미생성"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          공고 {child.servingState ?? "미생성"} · job{" "}
                          {child.deepAnalysisJobStatus ?? "미등록"} · S0~S14{" "}
                          {child.passedStageCount}/15 · 최근{" "}
                          {child.latestStage
                            ? `${DEEP_STAGE_LABELS[child.latestStage]} ${child.latestStageStatus ?? ""}`
                            : "receipt 없음"} · AI 자동검수{" "}
                          {aggregateSplitAuditLabel(child.aiAuditVerdict)} · S12{" "}
                          {child.publicationCompleteStatus ?? "대기"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          promotion {child.promotionReleaseId ?? "미생성"} ·{" "}
                          {child.promotionReleaseStatus ?? "대기"}/
                          {child.promotionItemStatus ?? "대기"}
                        </p>
                        <HashLine label="child input" value={child.inputSha256} />
                        <HashLine label="child input R2" value={child.inputArtifactKey} />
                        <HashLine
                          label="child source revision"
                          value={child.sourceRevisionSha256}
                        />
                        <HashLine label="deep analysis job" value={child.deepAnalysisJobId} />
                        <HashLine label="deep analysis run" value={child.deepAnalysisRunId} />
                        {child.activeFeederBypassReason ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            active feeder 우회: {child.activeFeederBypassReason}
                          </p>
                        ) : null}
                        {child.promotionLastErrorMessage ? (
                          <p className="mt-2 text-sm text-destructive">
                            {child.promotionLastErrorCode}: {child.promotionLastErrorMessage}
                          </p>
                        ) : null}
                        {child.lastErrorMessage ? (
                          <p className="mt-2 text-sm text-destructive">
                            {child.lastErrorCode}: {child.lastErrorMessage}
                          </p>
                        ) : null}
                        {child.publicationFirstBlocker ? (
                          <p className="mt-2 text-sm text-destructive">
                            첫 blocker{" "}
                            {child.publicationFirstBlocker.stage
                              ? DEEP_STAGE_LABELS[child.publicationFirstBlocker.stage]
                              : child.publicationFirstBlocker.code}
                            : {child.publicationFirstBlocker.message}
                          </p>
                        ) : (
                          <p className="mt-2 text-sm text-primary">
                            S0~S12와 독립 AI 자동검수 증적이 모두 확인됐습니다.
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : null}
                {detail.aggregateSplitCase.lastErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">
                    {detail.aggregateSplitCase.lastErrorCode}:{" "}
                    {detail.aggregateSplitCase.lastErrorMessage}
                  </p>
                ) : null}
                {detail.aggregateSplitCase.materializationLastErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">
                    {detail.aggregateSplitCase.materializationLastErrorCode}:{" "}
                    {detail.aggregateSplitCase.materializationLastErrorMessage}
                  </p>
                ) : null}
                {detail.aggregateSplitCase.promotionLastErrorMessage ? (
                  <p className="mt-3 text-sm text-destructive">
                    {detail.aggregateSplitCase.promotionLastErrorCode}:{" "}
                    {detail.aggregateSplitCase.promotionLastErrorMessage}
                  </p>
                ) : null}
              </section>
            ) : null}

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
  if (action === "release_exception") return "예외 배정 해제"
  return "통합공고 분리 승인"
}

function aggregateSplitStatusLabel(
  status: NonNullable<DeepPipelineNoticeDetail["aggregateSplitCase"]>["status"],
): string {
  if (status === "pending_review") return "사람 검토 대기"
  if (status === "approved") return "분리 작업 대기"
  if (status === "processing") return "분리 처리 중"
  if (status === "completed") return "분리 완료"
  return "분리 실패"
}

function aggregateSplitChildStatusLabel(
  status: NonNullable<
    DeepPipelineNoticeDetail["aggregateSplitCase"]
  >["children"][number]["status"],
): string {
  if (status === "pending") return "입력 준비 대기"
  if (status === "prepared") return "입력 봉인 완료"
  return "입력 준비 실패"
}

function aggregateSplitPromotionStatusLabel(
  status: NonNullable<
    DeepPipelineNoticeDetail["aggregateSplitCase"]
  >["promotionStatus"],
): string {
  if (status === "not_ready") return "승격 준비 전"
  if (status === "pending") return "staged 생성 대기"
  if (status === "staged") return "staged·분석 연결 중"
  if (status === "enqueued") return "깊은 분석 연결 완료"
  return "staged 승격 실패"
}

function aggregateSplitChildPipelineLabel(
  child: NonNullable<
    DeepPipelineNoticeDetail["aggregateSplitCase"]
  >["children"][number],
): string {
  if (child.status !== "prepared") return aggregateSplitChildStatusLabel(child.status)
  if (!child.stagedGrantAt) return "staged 생성 대기"
  if (!child.deepAnalysisJobId) return "분석 enqueue 대기"
  if (child.publicationFirstBlocker === null) return "S12 발행 완료"
  if (child.publicationFirstBlocker.stage) {
    return `첫 blocker ${DEEP_STAGE_LABELS[child.publicationFirstBlocker.stage]}`
  }
  if (child.aiAuditVerdict === "concur" && child.analysisCompleteStatus === "passed") {
    return "promotion 대기"
  }
  if (child.deepAnalysisRunId) return "깊은 분석 진행"
  return "깊은 분석 대기"
}

function aggregateSplitChildHasFailure(
  child: NonNullable<
    DeepPipelineNoticeDetail["aggregateSplitCase"]
  >["children"][number],
): boolean {
  return child.status === "failed"
    || child.publicationFirstBlocker !== null
    || Boolean(child.promotionLastErrorCode)
    || child.deepAnalysisJobStatus === "blocked"
    || child.deepAnalysisJobStatus === "dead_letter"
    || (
      child.aiAuditVerdict !== null
      && child.aiAuditVerdict !== "concur"
    )
}

function aggregateSplitAuditLabel(
  verdict: NonNullable<
    DeepPipelineNoticeDetail["aggregateSplitCase"]
  >["children"][number]["aiAuditVerdict"],
): string {
  if (verdict === "concur") return "동의"
  if (verdict === "disagree") return "불일치"
  if (verdict === "unsure") return "불확실"
  if (verdict === "failed") return "실패"
  return "대기"
}
