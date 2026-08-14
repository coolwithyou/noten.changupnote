"use client";

import Link from "next/link";
import { CircleAlert, CircleCheck, CircleX, FileCheck2, SearchCheck } from "lucide-react";
import type { LabBatchEvent, LabBatchJobSnapshot, LabBatchSummary } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { roundtripReviewHref } from "./roundtripReviewNavigation";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDurationMs, formatUsd } from "./batch-ops-format";

// ─────────────────────────────────────────────────────────────────────────────
// 진행 스트림 — 잡 스냅샷(LabBatchJobSnapshot)의 진행률·이벤트 링 버퍼를 그대로 렌더한다.
// 이벤트는 구조화 union(contract LabBatchEvent)이며 로그 파싱이 아니다. 표시는 최근순.
// ─────────────────────────────────────────────────────────────────────────────

const GUARD_STOP_MESSAGES: Record<"cost-cap" | "window-exhausted", string> = {
  "cost-cap": "명목 상한 도달 — 상한을 올려 재실행하면 이어서 진행합니다.",
  "window-exhausted": "Max 윈도 소진 — 리셋 후 재실행하세요.",
};

const GUARD_STOP_TITLES: Record<"cost-cap" | "window-exhausted", string> = {
  "cost-cap": "명목 상한 도달",
  "window-exhausted": "Max 윈도 소진",
};

const STOP_REASON_LABELS: Record<LabBatchSummary["stopReason"], string> = {
  completed: "정상 완료",
  "cost-cap": "명목 상한 도달",
  "window-exhausted": "Max 윈도 소진",
  aborted: "사용자 중단",
};

const STATE_META: Record<
  LabBatchJobSnapshot["state"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  idle: { label: "대기", variant: "outline" },
  running: { label: "실행 중", variant: "default" },
  finished: { label: "완료", variant: "secondary" },
  aborted: { label: "중단됨", variant: "outline" },
  error: { label: "러너 실패", variant: "destructive" },
};

export function BatchOpsProgressStream({ snapshot }: { snapshot: LabBatchJobSnapshot }) {
  const { progress } = snapshot;
  const completedWithoutTargets = snapshot.state === "finished"
    && snapshot.summary?.stopReason === "completed"
    && (progress?.total ?? 0) === 0;
  if (completedWithoutTargets) {
    return (
      <Alert>
        <CircleCheck />
        <AlertTitle>직전 실행은 처리 없이 종료됐습니다</AlertTitle>
        <AlertDescription>
          새로 분석할 공고가 없어 모델을 호출하지 않았습니다. 새 공고가 대기열에 들어오면 여기에서 다시 시작할 수 있습니다.
        </AlertDescription>
      </Alert>
    );
  }
  const heldCount = progress?.held ?? 0;
  const doneCount = progress ? progress.ok + heldCount + progress.error : 0;
  const percent = progress && progress.total > 0 ? (doneCount / progress.total) * 100 : 0;
  // 링 버퍼는 오래된 순으로 도착한다 — 표시는 최근순.
  const events = [...snapshot.events].reverse();
  const stateMeta = STATE_META[snapshot.state];

  return (
    <Card>
      <CardHeader>
        <CardTitle>현재 실행</CardTitle>
        <CardDescription className="tabular-nums">
          {snapshot.options ? `공고 최대 ${snapshot.options.limit}건 · 동시 ${snapshot.options.concurrency}건` : "직전 잡 정보 없음"}
          {snapshot.startedAt ? ` · ${formatDateTime(snapshot.startedAt)} 시작` : ""}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {snapshot.state === "running" ? <Spinner /> : null}
          {snapshot.origin === "cli" ? <Badge variant="outline">CLI 실행</Badge> : null}
          <Badge variant={stateMeta.variant}>{stateMeta.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
            <SearchCheck />
            <div className="min-w-0">
              <p className="text-sm font-medium">22축 딥분석</p>
              <p className="truncate text-xs text-muted-foreground">공고별 성공·오류를 독립 기록</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
            <FileCheck2 />
            <div className="min-w-0">
              <p className="text-sm font-medium">지원서 빠른 작성 분석</p>
              <p className="truncate text-xs text-muted-foreground">완료·부분·검토 필요를 별도 표시</p>
            </div>
          </div>
        </div>
        {snapshot.error ? (
          <Alert variant="destructive">
            <AlertTitle>러너 실패 (인프라)</AlertTitle>
            <AlertDescription className="break-words">{snapshot.error}</AlertDescription>
          </Alert>
        ) : null}

        {snapshot.guardStop ? (
          <Alert>
            <AlertTitle>가드 중단 — {GUARD_STOP_TITLES[snapshot.guardStop.reason]}</AlertTitle>
            <AlertDescription className="tabular-nums">
              {GUARD_STOP_MESSAGES[snapshot.guardStop.reason]} (누적 명목{" "}
              {formatUsd(snapshot.guardStop.cumulativeCostUsd)})
            </AlertDescription>
          </Alert>
        ) : null}

        {progress ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium tabular-nums">
                {doneCount} / {progress.total} 완료 (성공 {progress.ok} · 품질 보류 {heldCount} · 실패 {progress.error})
              </span>
              <span className="text-muted-foreground tabular-nums">
                누적 명목 {formatUsd(progress.cumulativeCostUsd)}
              </span>
            </div>
            <Progress value={percent} />
          </div>
        ) : null}

        <ScrollArea className="h-72 rounded-lg border border-border">
          <div className="flex flex-col gap-0.5 p-2">
            {events.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">이벤트가 아직 없습니다.</p>
            ) : (
              events.map((event, index) => (
                <EventRow key={`${snapshot.jobId ?? "job"}-${events.length - index}`} event={event} />
              ))
            )}
          </div>
        </ScrollArea>

        {snapshot.summary ? <BatchSummaryTable summary={snapshot.summary} /> : null}
      </CardContent>
    </Card>
  );
}

function EventRow({ event }: { event: LabBatchEvent }) {
  switch (event.type) {
    case "plan":
      return (
        <p className="px-1 py-1 text-xs text-muted-foreground tabular-nums">
          계획 — 실행 대상 {event.targets}건 / 전체 목록 {event.total}건
          {event.cohortLabel ? ` (${event.cohortLabel})` : ""} · 예상 명목{" "}
          {event.estimatedCostUsd !== null ? formatUsd(event.estimatedCostUsd) : "미상"} · ok 스킵{" "}
          {event.skippedOk} · 구버전만 {event.skippedOkOutdatedOnly} · 품질 held {event.skippedHeld ?? 0}
          {" "}· error 보류 {event.heldError}{" "}
          · 기간 스킵 {event.periodSkipped}
        </p>
      );
    case "target-started":
      return (
        <p className="px-1 py-1 text-xs text-muted-foreground tabular-nums">
          ({event.index + 1}/{event.total}) 시작 — {event.grantId} · {event.stratum}
        </p>
      );
    case "target-ok":
      return (
        <div className="flex items-start gap-1.5 px-1 py-1 text-xs">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <p className="min-w-0 break-words">
            <span className="tabular-nums">({event.index + 1}/{event.total})</span>{" "}
            <span className="font-medium">{event.title}</span>{" "}
            <span className="text-muted-foreground tabular-nums">
              · {formatDurationMs(event.durationMs)} ·{" "}
              {event.costUsd !== null ? formatUsd(event.costUsd) : "비용 미상"} · 누적{" "}
              {formatUsd(event.cumulativeCostUsd)}
            </span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              <Badge>22축 완료</Badge>
              {event.applicationRoundtrip ? (
                event.applicationRoundtrip.runId ? (
                  <Link
                    href={roundtripReviewHref(event.grantId, event.applicationRoundtrip.runId)}
                    title="저장된 Kordoc 결과 검토하기"
                  >
                    <Badge
                      variant={roundtripBadgeVariant(event.applicationRoundtrip.status)}
                      className="cursor-pointer transition-opacity hover:opacity-75"
                    >
                      Kordoc {roundtripStatusLabel(event.applicationRoundtrip.status)}
                      {event.applicationRoundtrip.adjudicationRounds
                        ? ` · AI 재판정 ${event.applicationRoundtrip.adjudicationRounds}회`
                        : ""}
                      {(event.applicationRoundtrip.remainingUnresolvedCandidateCount ?? 0) > 0
                        ? ` · 미해결 ${event.applicationRoundtrip.remainingUnresolvedCandidateCount}건`
                        : ""}
                      {" · 검토 열기"}
                    </Badge>
                  </Link>
                ) : (
                  <Badge variant={roundtripBadgeVariant(event.applicationRoundtrip.status)}>
                    Kordoc {roundtripStatusLabel(event.applicationRoundtrip.status)}
                  </Badge>
                )
              ) : (
                <Badge variant="outline">Kordoc 기록 없음</Badge>
              )}
            </span>
          </p>
        </div>
      );
    case "target-error":
      return (
        <div className="flex items-start gap-1.5 px-1 py-1 text-xs">
          <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 break-words">
            <span className="tabular-nums">({event.index + 1}/{event.total})</span>{" "}
            {event.grantId} — <span className="text-destructive">{event.message}</span>
            {event.runSaved ? null : (
              <span className="text-muted-foreground"> (런 미저장)</span>
            )}
          </p>
        </div>
      );
    case "target-held":
      return (
        <div className="flex items-start gap-1.5 px-1 py-1 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <p className="min-w-0 break-words">
            <span className="tabular-nums">({event.index + 1}/{event.total})</span>{" "}
            <span className="font-medium">{event.title}</span>{" "}
            <span className="text-muted-foreground tabular-nums">
              · primary 품질 보류 · {formatDurationMs(event.durationMs)} ·{" "}
              {event.costUsd !== null ? formatUsd(event.costUsd) : "비용 미상"} · 누적{" "}
              {formatUsd(event.cumulativeCostUsd)}
            </span>
          </p>
        </div>
      );
    case "guard-stop":
      return (
        <Alert className="my-1">
          <AlertTitle>가드 중단 — {GUARD_STOP_TITLES[event.reason]}</AlertTitle>
          <AlertDescription className="tabular-nums">
            {GUARD_STOP_MESSAGES[event.reason]} (누적 명목 {formatUsd(event.cumulativeCostUsd)})
          </AlertDescription>
        </Alert>
      );
    case "finished":
      return (
        <p className="px-1 py-1 text-xs font-medium tabular-nums">
          종료 — {STOP_REASON_LABELS[event.summary.stopReason]} · 성공 {event.summary.ok} · 품질
          보류 {event.summary.held ?? 0} · error 런 {event.summary.errorRuns} · 누적 명목{" "}
          {formatUsd(event.summary.totalCostUsd)}
        </p>
      );
  }
}

function roundtripStatusLabel(status: NonNullable<Extract<LabBatchEvent, { type: "target-ok" }>["applicationRoundtrip"]>["status"]): string {
  const labels = {
    complete: "완료",
    partial: "부분 완료",
    review_required: "검토 필요",
    not_applicable: "대상 아님",
    failed: "실패",
  } as const;
  return labels[status];
}

function roundtripBadgeVariant(
  status: NonNullable<Extract<LabBatchEvent, { type: "target-ok" }>["applicationRoundtrip"]>["status"],
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "complete") return "default";
  if (status === "failed") return "destructive";
  if (status === "partial" || status === "review_required") return "secondary";
  return "outline";
}

/** 종료 요약 표 — finished/aborted 시 summary 를 항목별로 펼친다. */
function BatchSummaryTable({ summary }: { summary: LabBatchSummary }) {
  const rows: Array<[string, string]> = [
    ["종료 사유", STOP_REASON_LABELS[summary.stopReason]],
    ["성공 런", `${summary.ok}건`],
    ["품질 보류 런", `${summary.held ?? 0}건`],
    ["error 런(저장됨)", `${summary.errorRuns}건`],
    ["런 저장 실패", `${summary.unsavedFailures}건`],
    ["미착수", `${summary.notStarted}건`],
    ["ok 스킵(현행)", `${summary.skippedOk}건`],
    ["구버전만 스킵", `${summary.skippedOkOutdatedOnly}건`],
    ["품질 held 스킵", `${summary.skippedHeld ?? 0}건`],
    ["error 보류", `${summary.heldError}건`],
    ["기간 스킵", `${summary.periodSkipped}건`],
    ["누적 명목 비용", formatUsd(summary.totalCostUsd)],
    ["소요", formatDurationMs(summary.durationMs)],
  ];
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell className="text-xs text-muted-foreground">{label}</TableCell>
              <TableCell className="text-right text-xs font-medium tabular-nums">{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
