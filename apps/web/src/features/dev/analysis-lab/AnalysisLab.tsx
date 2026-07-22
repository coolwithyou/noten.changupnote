"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, Circle, CircleHelp } from "lucide-react";
import {
  ANALYSIS_LAB_GATES,
  type LabAnalyzeResponse,
  type LabCohortResponse,
  type LabNoticeSummary,
  type LabRun,
  type LabRunResponse,
} from "./contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { auditBadgeMeta, noticeAuditStatus } from "./labels";
import { NoticeCard } from "./NoticeCard";
import { RunDetail } from "./RunDetail";

// ─────────────────────────────────────────────────────────────────────────────
// 공모 딥분석 실험실 (dev 전용) — 코호트 공고들을 Opus 로 딥분석하고,
// 실제 DB(grant_criteria 22축)가 어떻게 채워지는지 A/B diff 로 확인하는 스파이크 UI.
// DB에는 어떤 쓰기도 하지 않으며 런 결과는 서버가 파일로 불변 저장한다.
// 코호트 크기는 서버 소관 — UI 는 notices.length 를 그대로 따른다(건수 문구 하드코딩 금지).
// ─────────────────────────────────────────────────────────────────────────────

const COHORT_URL = "/api/dev/analysis-lab/cohort";

/** 통과 기준(게이트) 수 — contract 의 ANALYSIS_LAB_GATES 가 단일 원천. */
const GATE_COUNT = Object.keys(ANALYSIS_LAB_GATES).length;
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
  // 분석 완료 시 화면 전환을 보류했을 때의 카드 안내 (미저장 검수 초안 보호).
  const [analyzeNotices, setAnalyzeNotices] = useState<Record<string, string>>({});

  const [selected, setSelected] = useState<{ grantId: string; runId: string } | null>(null);
  const [run, setRun] = useState<LabRun | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // 상세 패널 탭 — "검수하기" 원클릭이 검수 탭을 바로 열 수 있도록 부모가 제어한다.
  const [detailTab, setDetailTab] = useState("fields");
  // 사용 순서 가이드 — 검수된 공고가 하나도 없으면 펼쳐서 시작(첫 코호트 로드 시 결정).
  const [guideOpen, setGuideOpen] = useState(false);
  const guideInitializedRef = useRef(false);
  // 카드 목록 필터 — 코호트가 커지면(30건+) 검수 대기 공고만 추려 보는 최소 내비게이션.
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  // 진행 보드의 미검수 항목 클릭 → 해당 공고 카드로 스크롤하기 위한 카드 엘리먼트 맵.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // React disabled 반영 전의 연속 클릭도 즉시 차단한다.
  const analyzeInFlightRef = useRef(false);
  const runRequestSeqRef = useRef(0);
  // 런 선택 직후 상세 패널로 자동 스크롤 — "패널이 어디 생겼는지 모르는" 혼란 방지.
  const scrollPendingRef = useRef(false);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // 검수 시트의 미저장 판정 여부 — 분석 완료 시 화면 탈취(초안 파괴)를 막는 가드.
  const reviewDirtyRef = useRef(false);

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
        if (!guideInitializedRef.current) {
          guideInitializedRef.current = true;
          setGuideOpen(
            !data.notices.some((notice) => notice.runs.some((item) => item.reviewedAt !== null)),
          );
        }
        if (options.refresh) {
          // 코호트가 재선정되면 이전 선택·런 표시는 무효.
          // in-flight selectRun 이 있으면 finally 의 seq 가드에 걸려 스피너가 잔류하므로
          // runLoading 도 여기서 함께 리셋한다.
          runRequestSeqRef.current += 1;
          setSelected(null);
          setRun(null);
          setRunError(null);
          setRunLoading(false);
          setAnalyzeErrors({});
          setAnalyzeNotices({});
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

  // 런이 로드되면 상세 패널로 스크롤 — 선택·검수하기 어느 경로든 동일.
  useEffect(() => {
    if (!run || !scrollPendingRef.current) return;
    scrollPendingRef.current = false;
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [run]);

  const selectRun = useCallback(async (grantId: string, runId: string) => {
    const seq = ++runRequestSeqRef.current;
    setSelected({ grantId, runId });
    setRunLoading(true);
    setRunError(null);
    scrollPendingRef.current = true;
    // 이 공고의 런을 열었으면 "분석 완료" 보류 안내는 소임을 다한 것.
    setAnalyzeNotices((previous) => {
      if (!(grantId in previous)) return previous;
      const next = { ...previous };
      delete next[grantId];
      return next;
    });
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

  /**
   * 공고 카드의 원클릭 검수 — 검수 탭을 바로 연다.
   * 검수된 성공 런이 있으면 그 런을 우선한다("검수 이어서 하기"가 실제 그 검수를 열도록,
   * 그리고 같은 공고를 새 런으로 이중 검수해 집계를 왜곡하지 않도록). 없으면 최신 성공 런.
   */
  const openReview = useCallback(
    (notice: LabNoticeSummary) => {
      const target =
        notice.runs.find((item) => item.ok && item.reviewedAt !== null) ??
        notice.runs.find((item) => item.ok);
      if (!target) return;
      setDetailTab("review");
      void selectRun(notice.grantId, target.runId);
    },
    [selectRun],
  );

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
        if (reviewDirtyRef.current) {
          // 검수 시트에 미저장 판정이 있으면 화면을 탈취하지 않는다 — 초안이 통째로
          // 리셋되기 때문. 카드에 완료 안내만 남기고, 런 목록은 조용히 갱신한다.
          setAnalyzeNotices((previous) => ({
            ...previous,
            [grantId]:
              "딥분석 완료 — 검수 중인 미저장 판정을 보호하기 위해 화면을 유지했습니다. 검수를 저장한 뒤 이 카드의 \"저장된 런\"에서 새 런을 열어보세요.",
          }));
        } else {
          // 완료된 런을 즉시 상세 패널에 반영. in-flight selectRun 무효화에 따른
          // 스피너 잔류를 막기 위해 runLoading 도 리셋한다.
          runRequestSeqRef.current += 1;
          setSelected({ grantId: data.run.grantId, runId: data.run.runId });
          setRun(data.run);
          setRunError(null);
          setRunLoading(false);
          scrollPendingRef.current = true;
        }
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

  const registerCard = useCallback(
    (grantId: string) => (element: HTMLDivElement | null) => {
      if (element) cardRefs.current.set(grantId, element);
      else cardRefs.current.delete(grantId);
    },
    [],
  );

  // 진행 보드 → 공고 카드 점프 (ReviewSheet 의 "다음 미판정" 점프와 동형 패턴).
  const jumpToNotice = useCallback((grantId: string) => {
    cardRefs.current.get(grantId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const selectedNotice =
    cohort?.notices.find((notice) => notice.grantId === selected?.grantId) ?? null;
  // 선택 런의 요약(감사 상태 포함) — RunDetail 이 감사 탭 노출 여부를 결정하는 데 쓴다.
  const selectedRunSummary =
    selectedNotice?.runs.find((item) => item.runId === selected?.runId) ?? null;

  // 필터 적용된 카드 목록 — 켜면 검수 대기(성공 런 검수 없음) 공고만 남는다.
  const visibleNotices = cohort
    ? showPendingOnly
      ? cohort.notices.filter((notice) => !hasReviewedOkRun(notice))
      : cohort.notices
    : [];

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

      <UsageGuide
        open={guideOpen}
        onOpenChange={setGuideOpen}
        noticeCount={cohort?.notices.length ?? 0}
      />

      {cohortError ? (
        <Alert variant="destructive">
          <AlertTitle>코호트 로드 실패</AlertTitle>
          <AlertDescription className="break-words">{cohortError}</AlertDescription>
        </Alert>
      ) : null}

      {cohort && cohort.notices.length > 0 ? (
        <ReviewProgressBoard
          notices={cohort.notices}
          showPendingOnly={showPendingOnly}
          onShowPendingOnlyChange={setShowPendingOnly}
          onJumpToNotice={jumpToNotice}
        />
      ) : null}

      {cohortLoading ? (
        <section className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </section>
      ) : cohort && cohort.notices.length > 0 ? (
        visibleNotices.length > 0 ? (
          <section className="grid items-start gap-4 lg:grid-cols-3">
            {visibleNotices.map((notice) => (
              <div key={notice.grantId} ref={registerCard(notice.grantId)} className="scroll-mt-6">
                <NoticeCard
                  notice={notice}
                  analyzing={analyzingGrantId === notice.grantId}
                  elapsedSec={elapsedSec}
                  analyzeDisabled={analyzingGrantId !== null}
                  analyzeError={analyzeErrors[notice.grantId] ?? null}
                  analyzeNotice={analyzeNotices[notice.grantId] ?? null}
                  selectedRunId={selected?.grantId === notice.grantId ? selected.runId : null}
                  onAnalyze={() => void analyze(notice.grantId)}
                  onSelectRun={(runId) => void selectRun(notice.grantId, runId)}
                  onReview={() => openReview(notice)}
                />
              </div>
            ))}
          </section>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>검수 대기 공고가 없습니다</EmptyTitle>
              <EmptyDescription>
                모든 공고가 검수됨 상태입니다 — &ldquo;검수 대기만 보기&rdquo;를 끄면 전체
                카드가 다시 보입니다.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
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
      <div ref={detailRef} className="scroll-mt-6">
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
          <RunDetail
            run={run}
            tab={detailTab}
            onTabChange={setDetailTab}
            noticeUrl={selectedNotice?.url ?? null}
            benefits={selectedNotice?.benefits ?? []}
            auditStatus={selectedRunSummary?.auditStatus ?? null}
            onReviewSaved={() => void loadCohort({ silent: true })}
            onReviewDirtyChange={(dirty) => {
              reviewDirtyRef.current = dirty;
            }}
          />
        ) : !cohortLoading && cohort ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>선택된 런이 없습니다</EmptyTitle>
              <EmptyDescription>
                공고 카드의 &ldquo;최신 런 검수하기&rdquo;를 누르거나 &ldquo;저장된 런&rdquo;에서 런을 선택하면
                분석 문서·필드 채움·검수 패널이 여기에 열립니다.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </main>
  );
}

/** 사용 순서 가이드 — 처음 온 검수자가 무엇부터 할지 4단계로 안내한다. */
function UsageGuide({
  open,
  onOpenChange,
  noticeCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 코호트 공고 수 — 로드 전이면 0(문구는 "전 공고"로 폴백). */
  noticeCount: number;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-xl border border-border bg-muted/20"
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" className="w-full justify-between px-4 py-3" />}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <CircleHelp data-icon="inline-start" />
          처음이신가요? — 사용 순서 안내
        </span>
        <ChevronDown data-icon="inline-end" className={cn("transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t border-border px-4 py-4">
        <div className="flex flex-col gap-2 text-sm">
          <GuideStep step={1}>
            공고 카드에서 <span className="font-medium">&ldquo;저장된 런&rdquo;</span>을 선택하거나{" "}
            <span className="font-medium">&ldquo;Opus 딥분석 실행&rdquo;</span>으로 새 런을 만듭니다
            (동기 분석 — 1~5분 소요).
          </GuideStep>
          <GuideStep step={2}>
            페이지 하단에 열리는 상세 패널의 <span className="font-medium">분석 문서</span>·
            <span className="font-medium">필드 채움</span> 탭에서 결과(22축 A/B diff)를 살핍니다.
          </GuideStep>
          <GuideStep step={3}>
            <span className="font-medium">검수</span> 탭에서 항목별로 판정하고{" "}
            <span className="font-medium">&ldquo;검수 저장&rdquo;</span>을 누릅니다 — 판정 기준·요령은
            검수 탭 상단 안내에 있습니다. 공고 카드의{" "}
            <span className="font-medium">&ldquo;최신 런 검수하기&rdquo;</span> 버튼이 이 단계로 바로
            데려다줍니다.
          </GuideStep>
          <GuideStep step={4}>
            코호트 {noticeCount > 0 ? `${noticeCount}건이` : "전 공고가"} 모두{" "}
            <span className="font-medium">검수됨</span>이 되면 터미널에서{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">pnpm lab:aggregate</code>
            를 실행합니다 — 통과 기준 {GATE_COUNT}종을 자동 판정합니다.
          </GuideStep>
        </div>
        <p className="text-xs text-muted-foreground">
          ⚠️ 검수 중에는 &ldquo;코호트 재선정&rdquo;을 누르지 마세요 — 공고 카드가 바뀌면 기존 런에
          화면으로 접근할 수 없게 됩니다(파일은 남습니다).
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function GuideStep({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
        {step}
      </span>
      <p className="min-w-0 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** 성공 런에 저장된 검수가 있는지 — 실패 런의 검수는 완료로 치지 않는다(집계도 동일). */
function hasReviewedOkRun(notice: LabNoticeSummary): boolean {
  return notice.runs.some((run) => run.ok && run.reviewedAt !== null);
}

/**
 * 검수 진행 보드 — 코호트 전체의 검수 완료 상태와 다음 단계를 보여준다.
 * 미검수 항목은 클릭 시 해당 공고 카드로 스크롤(30건 스케일 내비게이션),
 * "검수 대기만 보기" 토글로 카드 목록 필터를 제어한다.
 */
function ReviewProgressBoard({
  notices,
  showPendingOnly,
  onShowPendingOnlyChange,
  onJumpToNotice,
}: {
  notices: LabNoticeSummary[];
  showPendingOnly: boolean;
  onShowPendingOnlyChange: (pressed: boolean) => void;
  onJumpToNotice: (grantId: string) => void;
}) {
  const reviewedCount = notices.filter(hasReviewedOkRun).length;
  const allDone = reviewedCount === notices.length && notices.length > 0;

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">검수 진행</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Toggle
            variant="outline"
            size="sm"
            pressed={showPendingOnly}
            onPressedChange={onShowPendingOnlyChange}
            aria-label="검수 대기 공고만 보기"
          >
            검수 대기만 보기
          </Toggle>
          <Badge variant={allDone ? "default" : "secondary"} className="tabular-nums">
            {reviewedCount} / {notices.length} 공고
          </Badge>
        </div>
      </div>
      <Progress value={notices.length > 0 ? (reviewedCount / notices.length) * 100 : 0} />
      <div className="flex flex-col gap-1">
        {notices.map((notice) => {
          const reviewed = hasReviewedOkRun(notice);
          // 감사 상태(§9) — 사람 검수 없는 공고의 AI 검수 감사 진행을 최소 표시한다.
          const auditStatus = reviewed ? null : noticeAuditStatus(notice);
          const auditBadge = auditStatus ? auditBadgeMeta(auditStatus) : null;
          // 미검수 항목만 클릭 가능 — 누르면 해당 공고 카드로 스크롤한다.
          return reviewed ? (
            <div key={notice.grantId} className="flex min-w-0 items-center gap-1.5 px-1 text-xs">
              <CircleCheck className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">{notice.title}</span>
            </div>
          ) : (
            <Button
              key={notice.grantId}
              variant="ghost"
              size="sm"
              className="h-auto w-full min-w-0 justify-start gap-1.5 px-1 py-0.5 text-xs font-normal"
              title="공고 카드로 이동"
              onClick={() => onJumpToNotice(notice.grantId)}
            >
              <Circle className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-muted-foreground">{notice.title}</span>
              {auditBadge ? (
                <Badge variant={auditBadge.variant} className="ms-auto shrink-0 tabular-nums">
                  {auditBadge.label}
                </Badge>
              ) : null}
            </Button>
          );
        })}
      </div>
      {allDone ? (
        <Alert>
          <AlertTitle>코호트 검수 완료 🎉</AlertTitle>
          <AlertDescription>
            터미널에서{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              pnpm lab:aggregate
            </code>
            를 실행하면 정밀도·재현율·커버리지·비용·구조화 비율을 집계하고 통과 기준{" "}
            {GATE_COUNT}종을 자동 판정합니다.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          공고마다 런 1개 이상을 검수하면 완료로 표시됩니다. 미검수 공고를 클릭하면 해당
          카드로 이동합니다 — {notices.length}건 모두 검수 후{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">pnpm lab:aggregate</code>
          로 판정합니다.
        </p>
      )}
    </section>
  );
}
