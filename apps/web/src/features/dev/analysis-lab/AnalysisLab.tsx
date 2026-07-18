"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LabAnalyzeResponse, LabCohortResponse, LabRun, LabRunResponse } from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { NoticeCard } from "./NoticeCard";
import { RunDetail } from "./RunDetail";

// ─────────────────────────────────────────────────────────────────────────────
// 공모 딥분석 실험실 (dev 전용) — 코호트 3건의 공고를 Opus 로 딥분석하고,
// 실제 DB(grant_criteria 22축)가 어떻게 채워지는지 A/B diff 로 확인하는 스파이크 UI.
// DB에는 어떤 쓰기도 하지 않으며 런 결과는 서버가 파일로 불변 저장한다.
// ─────────────────────────────────────────────────────────────────────────────

const COHORT_URL = "/api/dev/analysis-lab/cohort";
const ANALYZE_URL = "/api/dev/analysis-lab/analyze";
const RUN_URL = "/api/dev/analysis-lab/run";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

export function AnalysisLab() {
  const [cohort, setCohort] = useState<LabCohortResponse | null>(null);
  const [cohortLoading, setCohortLoading] = useState(true);
  const [cohortError, setCohortError] = useState<string | null>(null);

  // 분석은 한 번에 하나만 실행한다 (동기 수 분 소요 — 클라이언트 타임아웃 없음).
  const [analyzingGrantId, setAnalyzingGrantId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [analyzeErrors, setAnalyzeErrors] = useState<Record<string, string>>({});

  const [selected, setSelected] = useState<{ grantId: string; runId: string } | null>(null);
  const [run, setRun] = useState<LabRun | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // React disabled 반영 전의 연속 클릭도 즉시 차단한다.
  const analyzeInFlightRef = useRef(false);
  const runRequestSeqRef = useRef(0);

  const loadCohort = useCallback(
    async (options: { refresh?: boolean; silent?: boolean } = {}) => {
      if (!options.silent) {
        setCohortLoading(true);
        setCohortError(null);
      }
      try {
        const url = options.refresh ? `${COHORT_URL}?refresh=1` : COHORT_URL;
        const response = await fetch(url);
        if (!response.ok) {
          setCohortError(await readErrorMessage(response, "코호트를 불러오지 못했습니다."));
          return;
        }
        const data = (await response.json()) as LabCohortResponse;
        setCohort(data);
        setCohortError(null);
        if (options.refresh) {
          // 코호트가 재선정되면 이전 선택·런 표시는 무효.
          runRequestSeqRef.current += 1;
          setSelected(null);
          setRun(null);
          setRunError(null);
          setAnalyzeErrors({});
        }
      } catch {
        if (!options.silent) setCohortError("네트워크 오류로 코호트를 불러오지 못했습니다.");
      } finally {
        if (!options.silent) setCohortLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadCohort();
  }, [loadCohort]);

  // 분석 실행 중 경과 시간(초) 표시.
  useEffect(() => {
    if (!analyzingGrantId) return;
    setElapsedSec(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [analyzingGrantId]);

  const selectRun = useCallback(async (grantId: string, runId: string) => {
    const seq = ++runRequestSeqRef.current;
    setSelected({ grantId, runId });
    setRunLoading(true);
    setRunError(null);
    try {
      const params = new URLSearchParams({ grantId, runId });
      const response = await fetch(`${RUN_URL}?${params.toString()}`);
      if (seq !== runRequestSeqRef.current) return;
      if (!response.ok) {
        setRunError(await readErrorMessage(response, "런을 불러오지 못했습니다."));
        setRun(null);
        return;
      }
      const data = (await response.json()) as LabRunResponse;
      if (seq !== runRequestSeqRef.current) return;
      setRun(data.run);
    } catch {
      if (seq === runRequestSeqRef.current) {
        setRunError("네트워크 오류로 런을 불러오지 못했습니다.");
        setRun(null);
      }
    } finally {
      if (seq === runRequestSeqRef.current) setRunLoading(false);
    }
  }, []);

  const analyze = useCallback(
    async (grantId: string) => {
      if (analyzeInFlightRef.current) return;
      analyzeInFlightRef.current = true;
      setAnalyzingGrantId(grantId);
      setAnalyzeErrors((previous) => {
        const next = { ...previous };
        delete next[grantId];
        return next;
      });
      try {
        // 주의: 분석은 1~5분 걸릴 수 있다 — fetch 에 클라이언트 타임아웃을 두지 않는다.
        const response = await fetch(ANALYZE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grantId }),
        });
        if (!response.ok) {
          const message = await readErrorMessage(response, "딥분석 실행에 실패했습니다.");
          setAnalyzeErrors((previous) => ({ ...previous, [grantId]: message }));
          return;
        }
        const data = (await response.json()) as LabAnalyzeResponse;
        // 완료된 런을 즉시 상세 패널에 반영하고, 런 목록·criteria 수는 조용히 갱신한다.
        runRequestSeqRef.current += 1;
        setSelected({ grantId: data.run.grantId, runId: data.run.runId });
        setRun(data.run);
        setRunError(null);
        void loadCohort({ silent: true });
      } catch {
        setAnalyzeErrors((previous) => ({
          ...previous,
          [grantId]: "네트워크 오류로 딥분석을 완료하지 못했습니다.",
        }));
      } finally {
        analyzeInFlightRef.current = false;
        setAnalyzingGrantId(null);
      }
    },
    [loadCohort],
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">공모 딥분석 실험실</h1>
          <Badge variant="outline">dev</Badge>
          {cohort ? (
            <>
              <Badge variant="secondary">{cohort.model}</Badge>
              <Badge variant="secondary">{cohort.promptVersion}</Badge>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            dev 전용 · DB 쓰기 없음 — 코호트 공고를 Opus 로 딥분석하고 grant_criteria 22축이
            어떻게 채워지는지 비교합니다. 런 결과는 파일로 불변 저장됩니다.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadCohort({ refresh: true })}
            disabled={cohortLoading || analyzingGrantId !== null}
          >
            코호트 재선정
          </Button>
        </div>
      </header>

      {cohortError ? (
        <Alert variant="destructive">
          <AlertTitle>코호트 로드 실패</AlertTitle>
          <AlertDescription className="break-words">{cohortError}</AlertDescription>
        </Alert>
      ) : null}

      {cohortLoading ? (
        <section className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </section>
      ) : cohort && cohort.notices.length > 0 ? (
        <section className="grid items-start gap-4 lg:grid-cols-3">
          {cohort.notices.map((notice) => (
            <NoticeCard
              key={notice.grantId}
              notice={notice}
              analyzing={analyzingGrantId === notice.grantId}
              elapsedSec={elapsedSec}
              analyzeDisabled={analyzingGrantId !== null}
              analyzeError={analyzeErrors[notice.grantId] ?? null}
              selectedRunId={selected?.grantId === notice.grantId ? selected.runId : null}
              onAnalyze={() => void analyze(notice.grantId)}
              onSelectRun={(runId) => void selectRun(notice.grantId, runId)}
            />
          ))}
        </section>
      ) : cohort ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>코호트가 비어 있습니다</EmptyTitle>
            <EmptyDescription>
              조건에 맞는 공고가 없습니다. 코호트 재선정을 눌러 다시 시도해 주세요.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {/* 상세 패널 — 선택된 런 */}
      {runLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-10 text-sm text-muted-foreground">
          <Spinner />
          런을 불러오는 중…
        </div>
      ) : runError ? (
        <Alert variant="destructive">
          <AlertTitle>런 로드 실패</AlertTitle>
          <AlertDescription className="break-words">{runError}</AlertDescription>
        </Alert>
      ) : run ? (
        <RunDetail run={run} onReviewSaved={() => void loadCohort({ silent: true })} />
      ) : !cohortLoading && cohort ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>선택된 런이 없습니다</EmptyTitle>
            <EmptyDescription>
              공고 카드에서 딥분석을 실행하거나 기존 런을 선택하면 분석 문서·필드 채움·실행 메타를
              여기서 확인할 수 있습니다.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </main>
  );
}
