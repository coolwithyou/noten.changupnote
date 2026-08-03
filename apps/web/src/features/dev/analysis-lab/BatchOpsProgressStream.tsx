"use client";

import { CircleCheck, CircleX } from "lucide-react";
import type { LabBatchEvent, LabBatchJobSnapshot, LabBatchSummary } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  const doneCount = progress ? progress.ok + progress.error : 0;
  const percent = progress && progress.total > 0 ? (doneCount / progress.total) * 100 : 0;
  // 링 버퍼는 오래된 순으로 도착한다 — 표시는 최근순.
  const events = [...snapshot.events].reverse();
  const stateMeta = STATE_META[snapshot.state];

  return (
    <Card>
      <CardHeader>
        <CardTitle>진행 스트림</CardTitle>
        <CardDescription className="tabular-nums">
          {snapshot.options
            ? `${snapshot.options.transport === "claude-cli" ? "구독 (claude CLI)" : "API"} · ${snapshot.options.model} · limit ${snapshot.options.limit} · 동시 ${snapshot.options.concurrency} · 상한 ${formatUsd(snapshot.options.maxCostUsd)}`
            : "직전 잡 정보 없음"}
          {snapshot.startedAt ? ` · ${formatDateTime(snapshot.startedAt)} 시작` : ""}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {snapshot.state === "running" ? <Spinner /> : null}
          <Badge variant={stateMeta.variant}>{stateMeta.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
                {doneCount} / {progress.total} 완료 (성공 {progress.ok} · 실패 {progress.error})
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
          계획 — 대상 {event.targets}건 / 코호트 {event.total}건
          {event.cohortLabel ? ` (${event.cohortLabel})` : ""} · 예상 명목{" "}
          {event.estimatedCostUsd !== null ? formatUsd(event.estimatedCostUsd) : "미상"} · ok 스킵{" "}
          {event.skippedOk} · 구버전만 {event.skippedOkOutdatedOnly} · error 보류 {event.heldError}{" "}
          · 기간 스킵 {event.periodSkipped}
        </p>
      );
    case "target-started":
      return (
        <p className="px-1 py-1 text-xs text-muted-foreground tabular-nums">
          ({event.index}/{event.total}) 시작 — {event.grantId} · {event.stratum}
        </p>
      );
    case "target-ok":
      return (
        <div className="flex items-start gap-1.5 px-1 py-1 text-xs">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <p className="min-w-0 break-words">
            <span className="tabular-nums">
              ({event.index}/{event.total})
            </span>{" "}
            <span className="font-medium">{event.title}</span>{" "}
            <span className="text-muted-foreground tabular-nums">
              · {formatDurationMs(event.durationMs)} ·{" "}
              {event.costUsd !== null ? formatUsd(event.costUsd) : "비용 미상"} · 누적{" "}
              {formatUsd(event.cumulativeCostUsd)}
            </span>
          </p>
        </div>
      );
    case "target-error":
      return (
        <div className="flex items-start gap-1.5 px-1 py-1 text-xs">
          <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 break-words">
            <span className="tabular-nums">
              ({event.index}/{event.total})
            </span>{" "}
            {event.grantId} — <span className="text-destructive">{event.message}</span>
            {event.runSaved ? null : (
              <span className="text-muted-foreground"> (런 미저장)</span>
            )}
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
          종료 — {STOP_REASON_LABELS[event.summary.stopReason]} · 성공 {event.summary.ok} · error
          런 {event.summary.errorRuns} · 누적 명목 {formatUsd(event.summary.totalCostUsd)}
        </p>
      );
  }
}

/** 종료 요약 표 — finished/aborted 시 summary 를 항목별로 펼친다. */
function BatchSummaryTable({ summary }: { summary: LabBatchSummary }) {
  const rows: Array<[string, string]> = [
    ["종료 사유", STOP_REASON_LABELS[summary.stopReason]],
    ["성공 런", `${summary.ok}건`],
    ["error 런(저장됨)", `${summary.errorRuns}건`],
    ["런 저장 실패", `${summary.unsavedFailures}건`],
    ["미착수", `${summary.notStarted}건`],
    ["ok 스킵(현행)", `${summary.skippedOk}건`],
    ["구버전만 스킵", `${summary.skippedOkOutdatedOnly}건`],
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
