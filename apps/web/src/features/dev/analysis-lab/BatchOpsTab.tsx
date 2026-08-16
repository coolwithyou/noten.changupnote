"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Gauge, ListChecks, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { LabBatchJobSnapshot, LabBatchStartRequest, LabOpsSummary } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { AnalysisLabPageHeader, AnalysisMetric } from "./AnalysisLabPageHeader";
import { AutomaticTargetSelectionCard } from "./AutomaticTargetSelectionCard";
import { BatchOpsConsole } from "./BatchOpsConsole";
import { BatchOpsFunnelBoard } from "./BatchOpsFunnelBoard";
import { BatchOpsProgressStream } from "./BatchOpsProgressStream";
import { localAnalysisRequestHeaders } from "./useLocalAnalysisRuntime";

// ─────────────────────────────────────────────────────────────────────────────
// 배치 운영 탭 (dev 전용) — 구독(claude CLI) 딥분석 배치를 명시적으로 실행·관찰·관리한다.
// 데이터: GET ops/summary(깔때기·transport 현황) + GET ops/batch(잡 스냅샷 — running 중 3s 폴링).
// 배치 라우트는 병렬 트랙이 구현 중일 수 있다(404) — 계약(contract.ts)대로 개발하고
// 미구현이면 안내 Alert 로 우아하게 알린다. DB 쓰기 없음, 런은 파일 불변 저장(기존 원칙 동일).
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_URL = "/api/dev/analysis-lab/ops/summary";
const BATCH_URL = "/api/dev/analysis-lab/ops/batch";
const BATCH_POLL_INTERVAL_MS = 3000;

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

export function BatchOpsTab({
  analysisAllowed,
  analysisOwnerId,
}: {
  analysisAllowed: boolean;
  analysisOwnerId: string | null;
}) {
  const [summary, setSummary] = useState<LabOpsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<LabBatchJobSnapshot | null>(null);
  // 배치 라우트 미구현(404) — 병렬 트랙 구현 대기 안내용(오류와 구분).
  const [batchRouteMissing, setBatchRouteMissing] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const loadSummary = useCallback(
    async (options: { refresh?: boolean; silent?: boolean } = {}) => {
      if (options.refresh) setSummaryRefreshing(true);
      else if (!options.silent) setSummaryLoading(true);
      try {
        const url = options.refresh ? `${SUMMARY_URL}?refresh=1` : SUMMARY_URL;
        const response = await fetch(url);
        if (!response.ok) {
          setSummaryError(await readErrorMessage(response, "운영 요약을 불러오지 못했습니다."));
          return;
        }
        setSummary((await response.json()) as LabOpsSummary);
        setSummaryError(null);
      } catch {
        setSummaryError("네트워크 오류로 운영 요약을 불러오지 못했습니다.");
      } finally {
        setSummaryLoading(false);
        setSummaryRefreshing(false);
      }
    },
    [],
  );

  const loadBatch = useCallback(async () => {
    try {
      const response = await fetch(BATCH_URL);
      if (response.status === 404) {
        setBatchRouteMissing(true);
        return;
      }
      if (!response.ok) {
        setBatchError(await readErrorMessage(response, "배치 상태를 불러오지 못했습니다."));
        return;
      }
      setBatchRouteMissing(false);
      setSnapshot((await response.json()) as LabBatchJobSnapshot);
    } catch {
      setBatchError("네트워크 오류로 배치 상태를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadBatch();
  }, [loadSummary, loadBatch]);

  // running 중에만 3s 폴링 — idle/finished 면 폴링 정지.
  const running = snapshot?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void loadBatch(), BATCH_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running, loadBatch]);

  // running → 종료 전이 시 깔때기를 조용히 재집계 — 새 런이 ④ 버킷을 바꾼다.
  const prevStateRef = useRef<LabBatchJobSnapshot["state"] | null>(null);
  useEffect(() => {
    const previous = prevStateRef.current;
    prevStateRef.current = snapshot?.state ?? null;
    if (previous === "running" && snapshot && snapshot.state !== "running") {
      void loadSummary({ silent: true });
    }
  }, [snapshot, loadSummary]);

  const startBatch = useCallback(
    async (request: LabBatchStartRequest) => {
      setStarting(true);
      setBatchError(null);
      try {
        const response = await fetch(BATCH_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...localAnalysisRequestHeaders(analysisOwnerId),
          },
          body: JSON.stringify(request),
        });
        if (response.status === 404) {
          setBatchRouteMissing(true);
          return;
        }
        if (response.status === 409) {
          setBatchError(
            "이미 실행 중인 배치가 있습니다 — 현재 잡을 중단하거나 완료를 기다려 주세요.",
          );
          void loadBatch();
          return;
        }
        if (!response.ok) {
          setBatchError(await readErrorMessage(response, "배치 시작에 실패했습니다."));
          return;
        }
        setBatchRouteMissing(false);
        setSnapshot((await response.json()) as LabBatchJobSnapshot);
      } catch {
        setBatchError("네트워크 오류로 배치를 시작하지 못했습니다.");
      } finally {
        setStarting(false);
      }
    },
    [analysisOwnerId, loadBatch],
  );

  const stopBatch = useCallback(async () => {
    setStopping(true);
    setBatchError(null);
    try {
      const response = await fetch(BATCH_URL, { method: "DELETE" });
      if (response.status === 404) {
        setBatchRouteMissing(true);
        return;
      }
      if (!response.ok) {
        setBatchError(await readErrorMessage(response, "배치 중단에 실패했습니다."));
        return;
      }
      setSnapshot((await response.json()) as LabBatchJobSnapshot);
    } catch {
      setBatchError("네트워크 오류로 배치를 중단하지 못했습니다.");
    } finally {
      setStopping(false);
    }
  }, []);

  const staleEmptyRun = Boolean(
    snapshot?.summary
    && (snapshot.progress?.total ?? 0) === 0
    && (summary === null || summary.funnel.analysisPending > 0),
  );
  const hasBatchHistory = Boolean(
    snapshot
    && !staleEmptyRun
    && (snapshot.jobId !== null || snapshot.state !== "idle"),
  );
  const showCompletionSteps = Boolean(snapshot?.summary && (snapshot.progress?.total ?? 0) > 0);

  return (
    <main className="flex w-full min-w-0 flex-col gap-6 pb-12">
      <AnalysisLabPageHeader
        icon={Gauge}
        eyebrow="BATCH ANALYSIS"
        title="배치 상태 관찰"
        description="과거 배치 진행 상태와 현재 대기·완료 분포를 읽기 전용으로 확인합니다."
        badges={summary ? (
          <Badge variant="secondary">{summary.transportStatus.resolved === "claude-cli" ? "구독 모델" : "API"}</Badge>
        ) : null}
      />

      {summaryError ? (
        <Alert variant="destructive">
          <AlertTitle>운영 요약 로드 실패</AlertTitle>
          <AlertDescription className="break-words">{summaryError}</AlertDescription>
        </Alert>
      ) : null}

      {summaryLoading && !summary ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}
        </div>
      ) : summary ? (
        <section aria-label="핵심 운영 지표" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AnalysisMetric label="분석 대기" value={summary.funnel.analysisPending} description="지금 배치에서 시작할 수 있는 공고" />
          <AnalysisMetric label="딥분석 완료" value={summary.funnel.analysisOkCurrent} description="현행 모델·프롬프트 기준 성공" />
          <AnalysisMetric label="검수 대기" value={summary.funnel.auditPending} description="사람 또는 AI 판정이 필요한 공고" />
          <AnalysisMetric label="승격 반영" value={summary.funnel.promotedGrants} description="매칭 대상에 반영된 공고" />
        </section>
      ) : null}

      {batchRouteMissing ? (
        <Alert>
          <AlertTitle>배치 라우트 준비 중</AlertTitle>
          <AlertDescription>
            /api/dev/analysis-lab/ops/batch 가 아직 없습니다(HTTP 404) — 병렬 트랙이 구현
            중입니다. 준비되면 페이지를 새로고침한 뒤 다시 시도하세요.
          </AlertDescription>
        </Alert>
      ) : null}

      {batchError ? (
        <Alert variant="destructive">
          <AlertTitle>배치 API 오류</AlertTitle>
          <AlertDescription className="break-words">{batchError}</AlertDescription>
        </Alert>
      ) : null}

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {hasBatchHistory && snapshot ? (
            <BatchOpsProgressStream snapshot={snapshot} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>최근 배치</CardTitle>
                <CardDescription>저장된 공고별 딥분석·Kordoc 진행 상태가 이곳에 표시됩니다.</CardDescription>
              </CardHeader>
              <CardContent>
                <Empty className="border py-10">
                  <EmptyHeader>
                    <EmptyTitle>실행 중인 배치가 없습니다</EmptyTitle>
                    <EmptyDescription>
                      현재 실행 중인 배치가 없습니다. 대기 수와 과거 결과만 확인할 수 있습니다.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}
          {showCompletionSteps ? <NextStepsCard /> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6">
          <AutomaticTargetSelectionCard
            analysisAllowed={analysisAllowed}
            analysisOwnerId={analysisOwnerId}
            pendingCount={summary?.funnel.analysisPending ?? null}
            batchRunning={running}
            onSelected={() => void loadSummary({ refresh: true })}
          />
          <BatchOpsConsole
            analysisAllowed={analysisAllowed}
            summary={summary}
            snapshot={snapshot}
            starting={starting}
            stopping={stopping}
            onStart={(request) => void startBatch(request)}
            onStop={() => void stopBatch()}
          />
          <ModeCard summary={summary} loading={summaryLoading} />
        </div>
      </section>

      {summary ? (
        <BatchOpsFunnelBoard
          summary={summary}
          refreshing={summaryRefreshing}
          onRefresh={() => void loadSummary({ refresh: true })}
        />
      ) : null}

    </main>
  );
}

/** 모드 카드 — 현 프로세스의 transport 해석 + 분석 대상 런(현행 ok)의 transport 분포. */
function ModeCard({ summary, loading }: { summary: LabOpsSummary | null; loading: boolean }) {
  return (
    <Collapsible>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck /> 실행 환경</CardTitle>
          <CardDescription>
            {summary?.transportStatus.resolved === "claude-cli" ? "Claude 구독으로 실행 · API 비용 $0" : "호출 방식을 확인하세요"}
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              상세 보기 <ChevronDown data-icon="inline-end" />
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3">
        {loading && !summary ? (
          <Skeleton className="h-16 w-full" />
        ) : summary ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {summary.transportStatus.resolved === "claude-cli" ? (
                <Badge>구독 · claude CLI</Badge>
              ) : (
                <Badge variant="secondary">API</Badge>
              )}
              <Badge variant="outline" className="max-w-full truncate">{summary.transportStatus.model}</Badge>
              <Badge variant="outline">
                {summary.transportStatus.envSource === "env"
                  ? "ANALYSIS_LAB_TRANSPORT 설정됨"
                  : "env 미설정 (기본값)"}
              </Badge>
              {summary.transportStatus.cliVersion ? (
                <Badge variant="outline" className="max-w-56 truncate">
                  CLI {summary.transportStatus.cliVersion}
                </Badge>
              ) : (
                <Badge variant="outline">CLI 버전 미확인</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              완료 런: 구독 {summary.transportStatus.runsByTransport.claudeCli}건 · API {summary.transportStatus.runsByTransport.api}건
            </p>
            {summary.transportStatus.resolved === "claude-cli" ? (
              <p className="text-xs text-muted-foreground">
                실지출 $0 — 표시 비용은 중단 게이트가 아닌 명목 telemetry입니다.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">운영 요약을 불러오지 못했습니다.</p>
        )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** 과거 배치 결과의 read-only 진단 안내. live 모델·감사 명령을 현행 절차로 노출하지 않는다. */
function NextStepsCard() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ListChecks /> 저장 결과 진단</CardTitle>
        <CardDescription>
          이 화면은 과거 배치와 저장 결과를 관찰하는 용도입니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Alert>
          <AlertTitle>legacy 모델·검수 경로 폐기</AlertTitle>
          <AlertDescription>
            AI 검수·블라인드 감사·자동 대상 선정은 현재 release 준비 절차가 아닙니다.
            신규 승격은 봉인된 receipt의 exact cohort만 사용합니다.
          </AlertDescription>
        </Alert>
        <CommandLine label="과거 review 표본 진단" command="pnpm lab:review:aggregate" />
      </CardContent>
    </Card>
  );
}

function CommandLine({
  label,
  command,
  hint,
}: {
  label: string;
  command: string;
  hint?: string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("명령을 복사했습니다.");
    } catch {
      toast.error("복사에 실패했습니다 — 명령을 직접 선택해 복사해 주세요.");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {hint ? <span className="font-normal"> — {hint}</span> : null}
      </span>
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${label} 명령 복사`}
          onClick={() => void copy()}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}
