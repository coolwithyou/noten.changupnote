"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  BotIcon,
  BrainCircuitIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  ListRestartIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  SubscriptionAgentOpsSnapshot,
  SubscriptionAgentOpsStage,
  SubscriptionAgentReportSummary,
} from "./contract"

const API_URL = "/api/admin/subscription-agent"
const ACTIVE_STATES = new Set(["planning", "running", "stopping"])
const WORKFLOW = [
  { stage: "selecting", label: "대상 선정", command: "신규 모집 공고 자동 선정", description: "새 모집 공고를 Opus로 고릅니다." },
  { stage: "analyzing", label: "22축 + Kordoc", command: "딥분석·Kordoc 병렬 실행", description: "자격조건과 빠른 작성을 함께 분석합니다." },
  { stage: "reviewing", label: "Fable 검수", command: "Fable 독립 검수", description: "추출 누락과 오분류를 독립 점검합니다." },
  { stage: "auditing", label: "Sonnet 감사", command: "Sonnet 블라인드 감사", description: "첫 검수에 영향받지 않고 재판정합니다." },
  { stage: "adjudicating", label: "Opus 판정", command: "Opus 충돌 3차 판정", description: "두 판단이 충돌한 항목만 확정합니다." },
  { stage: "repairing", label: "원인별 보정", command: "품질 재분석", description: "Kordoc·22축 blocker 공고만 다시 돕니다." },
] as const

export function SubscriptionAgentPageView({
  initialSnapshot,
}: {
  initialSnapshot: SubscriptionAgentOpsSnapshot
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [count, setCount] = useState<5 | 10 | 30>(30)
  const [pendingAction, setPendingAction] = useState<"plan" | "start" | "stop" | "refresh" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = ACTIVE_STATES.has(snapshot.runtime.state)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setPendingAction("refresh")
    try {
      const response = await fetch(API_URL, { cache: "no-store" })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "에이전트 상태를 불러오지 못했습니다.")
      setSnapshot(payload.data)
      setError(null)
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : "에이전트 상태를 불러오지 못했습니다.")
    } finally {
      if (!silent) setPendingAction(null)
    }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => void refresh(true), active ? 2_500 : 10_000)
    return () => window.clearInterval(interval)
  }, [active, refresh])

  const perform = async (action: "plan" | "start") => {
    setPendingAction(action)
    setError(null)
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, count }),
      })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "에이전트 요청을 처리하지 못했습니다.")
      setSnapshot(payload.data)
      toast.success(action === "plan" ? "실행 계획을 갱신했습니다." : "구독 분석 에이전트를 시작했습니다.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "에이전트 요청을 처리하지 못했습니다.")
    } finally {
      setPendingAction(null)
    }
  }

  const stop = async () => {
    setPendingAction("stop")
    setError(null)
    try {
      const response = await fetch(API_URL, { method: "DELETE" })
      const payload = await response.json() as ApiPayload
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "에이전트를 중단하지 못했습니다.")
      setSnapshot(payload.data)
      toast("중단 요청을 보냈습니다. 진행 중인 단계가 안전하게 종료되는지 확인하세요.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "에이전트를 중단하지 못했습니다.")
    } finally {
      setPendingAction(null)
    }
  }

  const progress = snapshot.batch.total > 0
    ? Math.min(100, ((snapshot.batch.ok + snapshot.batch.held + snapshot.batch.error) / snapshot.batch.total) * 100)
    : 0
  const latest = snapshot.latestReport
  const workflowCommands = snapshot.runtime.runId
    ? snapshot.runtime.observedCommands
    : latest?.commandLabels ?? []

  return (
    <main className="flex flex-col gap-5 p-4 md:p-6">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={snapshot.localAvailable ? "default" : "outline"}>
              <BotIcon data-icon="inline-start" />
              {snapshot.localAvailable ? "LOCAL AGENT" : "REMOTE READ ONLY"}
            </Badge>
            <StateBadge state={snapshot.runtime.state} />
            <Badge variant="secondary">Claude 구독 · API 비용 $0</Badge>
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">딥분석·Kordoc 품질 에이전트</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              새 공고 선정부터 22축 분석, 빠른 작성, 독립 검수, 충돌 판정과 원인별 보정까지 한 흐름으로 관리합니다.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={pendingAction !== null}>
            {pendingAction === "refresh" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            새로고침
          </Button>
          <Button
            nativeButton={false}
            render={<Link href="http://127.0.0.1:4010/dev/analysis-lab#batch-ops" target="_blank" />}
            variant="outline"
          >
            <ExternalLinkIcon data-icon="inline-start" />
            분석실 상세
          </Button>
        </div>
      </section>

      {!snapshot.localAvailable ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>이 환경에서는 에이전트를 실행할 수 없습니다</AlertTitle>
          <AlertDescription>
            실행·중단은 로컬 개발 서버의 127.0.0.1 또는 dev-ops.changupnote.com에서만 활성화됩니다.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>요청을 처리하지 못했습니다</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={ListRestartIcon}
          label="기존 품질 보정"
          value={snapshot.plan ? `${snapshot.plan.recoveryCount}건` : "계획 필요"}
          description="재시도 가능한 failed를 신규보다 먼저 처리"
        />
        <MetricCard
          icon={FileSearchIcon}
          label="선정된 미분석"
          value={snapshot.plan ? `${snapshot.plan.analysisCount}건` : "—"}
          description="현재 목록에서 바로 시작할 수 있는 공고"
        />
        <MetricCard
          icon={SparklesIcon}
          label="신규 안전 후보"
          value={snapshot.plan ? `${snapshot.plan.newCandidateCount}건` : "—"}
          description="기존 작업이 없을 때만 자동 선정"
        />
        <MetricCard
          icon={ShieldCheckIcon}
          label="최근 품질 종결"
          value={latest ? `${latest.completedCount}건` : "기록 없음"}
          description={latest ? `보류 ${latest.blockedCount} · Kordoc 재시도 ${latest.applicationRetryCount}` : "첫 실행 이후 결과가 표시됩니다"}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>품질 루프</CardTitle>
            <CardDescription>현재 에이전트가 어느 판단 단계에 있는지, 이미 통과한 단계가 무엇인지 보여줍니다.</CardDescription>
            <CardAction><StageBadge stage={snapshot.runtime.stage} /></CardAction>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {WORKFLOW.map((item, index) => {
                const status = workflowStatus({
                  stage: item.stage,
                  command: item.command,
                  activeStage: snapshot.runtime.stage,
                  observedCommands: workflowCommands,
                  finalStatus: snapshot.runtime.state,
                })
                return (
                  <li key={item.stage} className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                      <WorkflowBadge status={status} />
                    </div>
                    <p className="mt-3 font-medium">{item.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                  </li>
                )
              })}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>다음 조치</CardTitle>
            <CardDescription>현재 증거를 기준으로 관리자가 지금 해야 할 일입니다.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant={snapshot.nextAction.tone}>
              <BrainCircuitIcon />
              <AlertTitle>{snapshot.nextAction.title}</AlertTitle>
              <AlertDescription>{snapshot.nextAction.description}</AlertDescription>
            </Alert>
            {latest?.blockers.slice(0, 3).map((blocker) => (
              <div key={blocker.grantId} className="rounded-lg border p-3">
                <p className="truncate text-sm font-medium" title={blocker.grantId}>{blocker.grantId}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {blocker.reasons.join(" · ") || "세부 원인은 실행 로그에서 확인하세요."}
                </p>
              </div>
            ))}
            <Field>
              <FieldLabel>이번 실행 규모</FieldLabel>
              <ToggleGroup
                value={[String(count)]}
                variant="outline"
                onValueChange={(values) => {
                  const value = Number(values.at(-1))
                  if (value === 5 || value === 10 || value === 30) setCount(value)
                }}
                disabled={active || pendingAction !== null || !snapshot.localAvailable}
                aria-label="이번 실행 공고 수"
              >
                <ToggleGroupItem value="5">5건</ToggleGroupItem>
                <ToggleGroupItem value="10">10건</ToggleGroupItem>
                <ToggleGroupItem value="30">30건</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void perform("plan")}
              disabled={active || pendingAction !== null || !snapshot.localAvailable}
            >
              {pendingAction === "plan" ? <Spinner data-icon="inline-start" /> : <ActivityIcon data-icon="inline-start" />}
              계획 확인
            </Button>
            {active ? (
              <Button variant="destructive" onClick={() => void stop()} disabled={pendingAction !== null}>
                {pendingAction === "stop" ? <Spinner data-icon="inline-start" /> : <CircleStopIcon data-icon="inline-start" />}
                현재 실행 중단
              </Button>
            ) : (
              <Button onClick={() => void perform("start")} disabled={pendingAction !== null || !snapshot.localAvailable}>
                {pendingAction === "start" ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                {count}건 실행
              </Button>
            )}
          </CardFooter>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            현재 실행
            <BatchStateBadge state={snapshot.batch.state} />
          </CardTitle>
          <CardDescription>
            {snapshot.batch.jobId ?? snapshot.runtime.runId ?? "아직 시작한 실행이 없습니다."}
          </CardDescription>
          <CardAction>
            <Badge variant="outline">{snapshot.batch.transport ?? "claude-cli"} · {snapshot.batch.model ?? "claude-opus-5"}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">딥분석·Kordoc 배치</span>
            <span className="text-muted-foreground tabular-nums">
              {snapshot.batch.ok + snapshot.batch.held + snapshot.batch.error} / {snapshot.batch.total}
            </span>
          </div>
          <Progress value={progress} aria-label="딥분석과 Kordoc 배치 진행률" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <InlineMetric label="시작" value={`${snapshot.batch.started}건`} />
            <InlineMetric label="성공" value={`${snapshot.batch.ok}건`} />
            <InlineMetric label="품질 보류" value={`${snapshot.batch.held}건`} />
            <InlineMetric label="실패" value={`${snapshot.batch.error}건`} />
            <InlineMetric label="명목 비용" value={`$${snapshot.batch.nominalCostUsd.toFixed(2)}`} />
            <InlineMetric
              label="실행 시간"
              value={formatElapsed(snapshot.runtime.startedAt, snapshot.runtime.finishedAt, snapshot.refreshedAt)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>실행 증거</CardTitle>
          <CardDescription>실시간 로그와 불변 에이전트 보고서를 함께 확인합니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="logs">
            <TabsList>
              <TabsTrigger value="logs">실시간 로그</TabsTrigger>
              <TabsTrigger value="history">실행 기록 {snapshot.history.length}</TabsTrigger>
            </TabsList>
            <TabsContent value="logs" className="pt-3">
              {snapshot.runtime.logLines.length > 0 ? (
                <pre className="max-h-[28rem] overflow-auto rounded-lg bg-muted p-4 text-xs leading-5 whitespace-pre-wrap">
                  {snapshot.runtime.logLines.join("\n")}
                </pre>
              ) : (
                <Alert>
                  <ActivityIcon />
                  <AlertTitle>아직 실행 로그가 없습니다</AlertTitle>
                  <AlertDescription>계획 확인은 모델을 호출하지 않으며, 실제 실행을 시작하면 단계별 로그가 나타납니다.</AlertDescription>
                </Alert>
              )}
            </TabsContent>
            <TabsContent value="history" className="pt-3">
              <ReportHistory reports={snapshot.history} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Separator />
      <p className="text-xs text-muted-foreground">
        이 페이지는 분석 산출물을 프로덕션 DB로 승격하지 않습니다. 승격과 랜딩 반영은 별도 품질 게이트 이후에만 진행됩니다.
      </p>
    </main>
  )
}

interface ApiPayload {
  data?: SubscriptionAgentOpsSnapshot
  error?: { message?: string }
}

function MetricCard({
  icon: Icon,
  label,
  value,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  description: string
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-muted"><Icon /></span>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

function InlineMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  )
}

function ReportHistory({ reports }: { reports: SubscriptionAgentReportSummary[] }) {
  if (reports.length === 0) {
    return (
      <Alert>
        <ActivityIcon />
        <AlertTitle>저장된 에이전트 보고서가 없습니다</AlertTitle>
        <AlertDescription>첫 실행이 종결되면 대상·교정·차단 결과가 불변 기록으로 나타납니다.</AlertDescription>
      </Alert>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>실행</TableHead>
          <TableHead>상태</TableHead>
          <TableHead>대상</TableHead>
          <TableHead>품질 종결</TableHead>
          <TableHead>남은 보정</TableHead>
          <TableHead>소요 시간</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reports.map((report) => (
          <TableRow key={report.agentId}>
            <TableCell>
              <p className="font-medium">{formatDateTime(report.startedAt)}</p>
              <p className="max-w-52 truncate text-xs text-muted-foreground" title={report.agentId}>{report.agentId}</p>
            </TableCell>
            <TableCell><ReportStatusBadge status={report.status} /></TableCell>
            <TableCell>{report.analyzedCount + report.resumedCount}건</TableCell>
            <TableCell>{report.completedCount}건</TableCell>
            <TableCell>
              Kordoc {report.applicationRetryCount} · 22축 {report.deepRetryCount} · 차단 {report.blockedCount}
            </TableCell>
            <TableCell>{formatDuration(report.durationMs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function StateBadge({ state }: { state: SubscriptionAgentOpsSnapshot["runtime"]["state"] }) {
  if (state === "failed") return <Badge variant="destructive">실패</Badge>
  if (state === "partial") return <Badge variant="secondary">일부 보류</Badge>
  if (ACTIVE_STATES.has(state)) return <Badge><Spinner data-icon="inline-start" />실행 중</Badge>
  if (state === "completed") return <Badge variant="secondary">종결</Badge>
  return <Badge variant="outline">대기</Badge>
}

function StageBadge({ stage }: { stage: SubscriptionAgentOpsStage }) {
  return <Badge variant={stage === "idle" || stage === "finished" ? "outline" : "secondary"}>{stageLabel(stage)}</Badge>
}

function BatchStateBadge({ state }: { state: SubscriptionAgentOpsSnapshot["batch"]["state"] }) {
  if (state === "error" || state === "aborted") return <Badge variant="destructive">{state === "error" ? "오류" : "중단"}</Badge>
  if (state === "running") return <Badge><Spinner data-icon="inline-start" />진행 중</Badge>
  if (state === "finished") return <Badge variant="secondary">완료</Badge>
  return <Badge variant="outline">대기</Badge>
}

function ReportStatusBadge({ status }: { status: SubscriptionAgentReportSummary["status"] }) {
  if (status === "failed") return <Badge variant="destructive">실패</Badge>
  if (status === "partial") return <Badge variant="secondary">일부 보류</Badge>
  return <Badge>완료</Badge>
}

function WorkflowBadge({ status }: { status: "done" | "current" | "pending" | "skipped" | "failed" }) {
  if (status === "failed") return <Badge variant="destructive">확인 필요</Badge>
  if (status === "current") return <Badge><Spinner data-icon="inline-start" />진행 중</Badge>
  if (status === "done") return <Badge variant="secondary">완료</Badge>
  if (status === "skipped") return <Badge variant="outline">대상 없음</Badge>
  return <Badge variant="outline">대기</Badge>
}

function workflowStatus(input: {
  stage: SubscriptionAgentOpsStage
  command: string
  activeStage: SubscriptionAgentOpsStage
  observedCommands: string[]
  finalStatus: SubscriptionAgentOpsSnapshot["runtime"]["state"]
}): "done" | "current" | "pending" | "skipped" | "failed" {
  if (ACTIVE_STATES.has(input.finalStatus) && input.activeStage === input.stage) return "current"
  const observed = input.stage === "repairing"
    ? input.observedCommands.some((command) => command.includes("교정") || command.includes("재분석"))
    : input.observedCommands.includes(input.command)
  if (observed) return input.finalStatus === "failed" ? "failed" : "done"
  if (!ACTIVE_STATES.has(input.finalStatus) && input.finalStatus !== "idle") return "skipped"
  return "pending"
}

function stageLabel(stage: SubscriptionAgentOpsStage): string {
  return ({
    idle: "대기",
    planning: "계획 계산",
    starting: "시작 준비",
    selecting: "신규 공고 선정",
    analyzing: "딥분석·Kordoc",
    reviewing: "Fable 검수",
    auditing: "Sonnet 감사",
    adjudicating: "Opus 충돌 판정",
    repairing: "원인별 보정",
    finished: "종결",
  })[stage]
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date)
}

function formatElapsed(start: string | null, end: string | null, observedAt: string): string {
  if (!start) return "—"
  const startMs = new Date(start).getTime()
  const endMs = new Date(end ?? observedAt).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "—"
  return formatDuration(Math.max(0, endMs - startMs))
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}시간 ${minutes}분`
  if (minutes > 0) return `${minutes}분 ${seconds}초`
  return `${seconds}초`
}
