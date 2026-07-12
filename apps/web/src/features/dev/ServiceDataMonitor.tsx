"use client";

import {
  measureAutofillCoverage,
  type AutofillCoverageMetrics,
  type AutofillGrantWeights,
  type EvidenceSourceKind,
} from "@cunote/core/autofill/coverage";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  FieldCoverageRow,
  FieldCoverageStatus,
  FieldSourceRef,
  FieldTier,
  QnaSchema,
  ServiceDataInspectResult,
  ServiceDataLookupResult,
  ServiceDataProvider,
  ServiceDataTraceEntry,
} from "@/lib/server/devServiceDataMonitor";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CodefSimpleAuthPanel } from "./CodefSimpleAuthPanel";

// ─────────────────────────────────────────────────────────────────────────────
// 개발 전용 사업자 데이터 모니터 → 매칭 22축 "필드 커버리지 하네스".
// 조회 파이프라인(팝빌·국세청·공공구매종합정보망)과 Apick의 라이브/캐시 원천을 투명하게 드러내고,
// 신규 외부소스(kcomwel·금융위·NICE·CODEF·명단 배치)는 계획 소스 라벨 + pending 배지로만 표시한다.
// API로 확보 불가한 축은 Q&A(자가신고)로 병합해 어떤 플래그가 채워지는지 눈으로 확인한다.
// Q&A 입력은 서버에 저장하지 않는 클라이언트 로컬 상태 — 매칭 축 채움을 확인하는 용도.
// ─────────────────────────────────────────────────────────────────────────────

const CERT_OPTIONS = [
  "벤처기업확인서",
  "이노비즈",
  "메인비즈",
  "기업부설연구소",
  "여성기업확인서",
  "장애인기업확인서",
  "사회적기업",
  "중소기업확인서",
  "소상공인확인서",
  "창업기업확인서",
] as const;

const TRAIT_OPTIONS = ["여성", "장애인", "청년", "시니어"] as const;

const DISQ_AXES = ["tax_compliance", "credit_status", "sanction"] as const;

type MergedCoverageRow = FieldCoverageRow & {
  /** 결격 축: 질의·확인된 플래그 라벨(known_flags). */
  knownFlagLabels?: string[];
  /** 결격 축: 보유(있음)로 신고된 플래그 라벨. */
  presentFlagLabels?: string[];
  /** 결격 축: 선언한 예외 라벨. */
  exceptionLabels?: string[];
};

interface QnaState {
  birthYear: string;
  traits: string[];
  employees: string;
  revenueEok: string;
  certs: string[];
  priorAward: string;
  ipCount: string;
  isPreliminary: boolean;
  // 결격 3축 — 문항 그룹(canonical)별: 확인함 + 보유(있음) 플래그.
  disqConfirmed: Record<string, boolean>;
  disqFlags: Record<string, string[]>;
  disqExceptions: string[];
  // 재무건전성
  capitalImpairment: "" | "none" | "partial" | "full";
  equityEok: string;
  // 고용
  noLayoff: "" | "yes" | "no";
  /** 감원 있음일 때 마지막 감원 후 경과 개월(months_since_last_layoff). 미입력이면 매칭은 unknown. */
  layoffMonths: string;
  // 투자
  investmentEok: string;
  investmentRound: string;
  tipsBacked: boolean;
}

const EMPTY_QNA: QnaState = {
  birthYear: "",
  traits: [],
  employees: "",
  revenueEok: "",
  certs: [],
  priorAward: "",
  ipCount: "",
  isPreliminary: false,
  disqConfirmed: {},
  disqFlags: {},
  disqExceptions: [],
  capitalImpairment: "",
  equityEok: "",
  noLayoff: "",
  layoffMonths: "",
  investmentEok: "",
  investmentRound: "",
  tipsBacked: false,
};

export function ServiceDataMonitor({ qnaSchema }: { qnaSchema: QnaSchema }) {
  const [bizNoInput, setBizNoInput] = useState("");
  const [provider, setProvider] = useState<ServiceDataProvider>("popbill");
  const [activeBizNo, setActiveBizNo] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inspect, setInspect] = useState<ServiceDataInspectResult | null>(null);
  const [result, setResult] = useState<ServiceDataLookupResult | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [qna, setQna] = useState<QnaState>(EMPTY_QNA);
  // React disabled 상태가 반영되기 전의 연속 Enter/클릭도 즉시 차단한다.
  const searchInFlightRef = useRef(false);
  const lookupInFlightRef = useRef(new Map<string, Promise<void>>());
  // 커버리지 테이블 상태 필터("all" 이면 전체). 요약 카드의 범례 칩과 연동된다.
  const [statusFilter, setStatusFilter] = useState<StatusGroup | "all">("all");

  const runLookup = useCallback((bizNo: string, forceRefresh: boolean, selectedProvider: ServiceDataProvider) => {
    const requestKey = `${selectedProvider}:${bizNo}:${forceRefresh ? "refresh" : "cache"}`;
    const existing = lookupInFlightRef.current.get(requestKey);
    if (existing) return existing;

    const task = (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/dev/service-data", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bizNo, forceRefresh, provider: selectedProvider }),
        });
        const data = (await res.json()) as ServiceDataLookupResult & { message?: string };
        if (!res.ok) {
          toast.error(data.message ?? "조회에 실패했습니다.");
          return;
        }
        setResult(data);
        if (data.error) {
          toast.warning(`${data.error.code}: ${data.error.message}`);
        } else {
          toast.success(forceRefresh ? "캐시를 비우고 새로 조회했습니다." : "조회를 완료했습니다.");
        }
        // 조회 직후 캐시 스냅샷을 갱신해 이후 재조회 시 원천 표시가 최신이 되도록 한다.
        // 조회 본체는 이미 성공했으므로 스냅샷 갱신 실패가 오류 토스트로 새지 않게 분리한다.
        try {
          const refreshed = await fetch(`/api/dev/service-data?bizNo=${bizNo}&provider=${selectedProvider}`);
          if (refreshed.ok) setInspect((await refreshed.json()) as ServiceDataInspectResult);
        } catch {
          // 스냅샷 갱신 실패는 무시(다음 조회 시 재확인).
        }
      } catch {
        toast.error("네트워크 오류로 조회하지 못했습니다.");
      } finally {
        setLoading(false);
      }
    })().finally(() => {
      if (lookupInFlightRef.current.get(requestKey) === task) {
        lookupInFlightRef.current.delete(requestKey);
      }
    });
    lookupInFlightRef.current.set(requestKey, task);
    return task;
  }, []);

  const onSearch = useCallback(async () => {
    const digits = bizNoInput.replace(/\D/g, "");
    if (digits.length !== 10) {
      toast.error("사업자번호 10자리를 입력해주세요.");
      return;
    }
    if (searchInFlightRef.current) return;
    searchInFlightRef.current = true;
    setActiveBizNo(digits);
    setResult(null);
    setInspecting(true);
    try {
      const res = await fetch(`/api/dev/service-data?bizNo=${digits}&provider=${provider}`);
      const data = (await res.json()) as ServiceDataInspectResult & { message?: string };
      if (!res.ok) {
        toast.error(data.message ?? "캐시 조회에 실패했습니다.");
        return;
      }
      setInspect(data);
      // 캐시 행이 하나도 없으면 선택 없이 바로 파이프라인 조회.
      if (!data.hasCache) {
        await runLookup(digits, false, provider);
      }
    } catch {
      toast.error("네트워크 오류로 캐시를 확인하지 못했습니다.");
    } finally {
      searchInFlightRef.current = false;
      setInspecting(false);
    }
  }, [bizNoInput, provider, runLookup]);

  const onClearCache = useCallback(async () => {
    if (!activeBizNo) return;
    setClearing(true);
    try {
      const res = await fetch(`/api/dev/service-data?bizNo=${activeBizNo}&provider=${provider}`, { method: "DELETE" });
      const data = (await res.json()) as { deleted?: number; message?: string };
      if (!res.ok) {
        toast.error(data.message ?? "캐시를 비우지 못했습니다.");
        return;
      }
      toast.success(`캐시 ${data.deleted ?? 0}건을 삭제했습니다.`);
      setResult(null);
      setInspect((prev) => (prev ? { ...prev, hasCache: false, rows: [] } : prev));
    } catch {
      toast.error("네트워크 오류로 캐시를 비우지 못했습니다.");
    } finally {
      setClearing(false);
      setClearOpen(false);
    }
  }, [activeBizNo, provider]);

  const mergedCoverage = useMemo(
    () => mergeFieldsWithQna(result?.coverage ?? [], qna, qnaSchema),
    [result?.coverage, qna, qnaSchema],
  );
  const overview = useMemo(
    () => summarizeCoverage(mergedCoverage, result?.coverageGrantWeights ?? null),
    [mergedCoverage, result?.coverageGrantWeights],
  );
  const reasonGroups = useMemo(() => groupByReason(mergedCoverage), [mergedCoverage]);
  const filteredCoverage = useMemo(
    () =>
      statusFilter === "all"
        ? mergedCoverage
        : mergedCoverage.filter((row) => statusGroupOf(row.status) === statusFilter),
    [mergedCoverage, statusFilter],
  );

  const busy = inspecting || loading;
  const showCacheChoice = Boolean(inspect?.hasCache && activeBizNo);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">사업자 데이터 모니터</h1>
          <Badge variant="outline">dev</Badge>
          <Badge variant="secondary">22축 커버리지 하네스</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          사업자번호로 조회 provider를 선택해 실행하고, 매칭 22축의 계획 소스·상태·값·신뢰도와
          라이브/캐시 여부, 원본 응답을 확인합니다. 신규 외부소스는 키 확보 전까지 대기(pending)로 표시됩니다.
        </p>
      </header>

      {/* 1. 조회 바 */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label className="block">조회 provider</Label>
              <div className="flex rounded-md border border-border bg-muted/40 p-1">
                {(["popbill", "apick"] as const).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    size="sm"
                    variant={provider === item ? "default" : "ghost"}
                    className="h-8"
                    disabled={busy}
                    onClick={() => {
                      setProvider(item);
                      setInspect(null);
                      setResult(null);
                    }}
                  >
                    {providerLabel(item)}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <Label htmlFor="dev-biz-no" className="mb-1.5 block">
                사업자등록번호
              </Label>
              <Input
                id="dev-biz-no"
                inputMode="numeric"
                placeholder="10자리 (하이픈 무시)"
                value={bizNoInput}
                onChange={(event) => setBizNoInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSearch();
                }}
                disabled={busy}
              />
            </div>
            <Button onClick={() => void onSearch()} disabled={busy}>
              {inspecting ? "확인 중…" : "조회"}
            </Button>
            {activeBizNo ? (
              <Button
                variant="outline"
                onClick={() => setClearOpen(true)}
                disabled={busy || clearing}
              >
                캐시 비우기
              </Button>
            ) : null}
          </div>

          {showCacheChoice ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-sm font-medium">
              저장된 캐시 {inspect?.rows.length ?? 0}건이 있습니다.
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
                {provider === "apick"
                  ? "Apick 테스트 계정은 호출 수가 제한되어 있어 캐시 재사용이 기본입니다. 새로 조회는 서버 가드가 허용하는 범위에서만 실행됩니다."
                  : "캐시를 사용하면 유료 조회(팝빌) 없이 저장 결과를 재사용합니다. 새로 조회하면 캐시를 비우고 원소스를 다시 호출합니다."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => activeBizNo && void runLookup(activeBizNo, false, provider)}
                  disabled={loading}
                >
                  캐시 사용해 조회
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => activeBizNo && void runLookup(activeBizNo, true, provider)}
                  disabled={loading}
                >
                  캐시 무효화 후 새로 조회
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* CODEF 간편인증 — 국세청 확정값을 커버리지에 병합 */}
      <CodefSimpleAuthPanel
        defaultBizNo={activeBizNo ?? ""}
        onCompleted={(codefBizNo) => {
          // 인증 완료 후 같은 사업자번호를 재조회해 커버리지에 국세청(CODEF) 원천을 병합한다.
          if (activeBizNo && codefBizNo === activeBizNo) void runLookup(activeBizNo, false, provider);
        }}
      />

      {loading ? <LookupSkeleton /> : null}

      {result?.error ? (
        <Alert variant="destructive">
          <AlertTitle>{errorTitle(result.error.code)}</AlertTitle>
          <AlertDescription>
            {result.error.message}
            <span className="text-muted-foreground">
              {" "}
              (code: {result.error.code} · status: {result.error.status})
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {result && !loading ? (
        <>
          {/* 2. 커버리지 요약 — 몇 축이 채워지는지 + 왜 그런지 */}
          <CoverageOverview
            overview={overview}
            reasonGroups={reasonGroups}
            statusFilter={statusFilter}
            onFilter={setStatusFilter}
            maskedBizNo={result.maskedBizNo}
            subject={result.subject}
          />

          {/* 3. 필드별 상세 테이블 (요약 칩으로 필터) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <CardTitle className="text-base">필드별 상세</CardTitle>
                  <CardDescription>
                    {statusFilter === "all"
                      ? `매칭 축 ${overview.total}개 전체 · 계획 소스와 확보 상태`
                      : `${GROUP_META[statusFilter].label} ${filteredCoverage.length}개만 표시 중`}
                  </CardDescription>
                </div>
                {statusFilter === "all" ? null : (
                  <Button size="sm" variant="ghost" onClick={() => setStatusFilter("all")}>
                    전체 보기
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {filteredCoverage.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {statusFilter === "all"
                    ? "표시할 축이 없습니다."
                    : `${GROUP_META[statusFilter].label} 상태인 축이 없습니다.`}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[16%] min-w-[7rem]">필드</TableHead>
                        <TableHead className="w-[6%]">층</TableHead>
                        <TableHead className="w-[10%]">상태</TableHead>
                        <TableHead className="w-[22%]">값</TableHead>
                        <TableHead className="w-[40%]">채워지는 조건 · 근거</TableHead>
                        <TableHead className="w-[6%] text-right">신뢰도</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCoverage.map((row) => (
                        <TableRow key={row.key} className={row.parentKey ? "border-0" : "border-t-2 border-border"}>
                          <TableCell
                            className={`align-top ${row.parentKey ? "py-1.5 pl-6 text-xs text-muted-foreground" : "font-medium"}`}
                          >
                            <span className="break-words">{row.parentKey ? `└ ${row.label}` : row.label}</span>
                          </TableCell>
                          <TableCell className={`align-top ${row.parentKey ? "py-1.5" : ""}`}>
                            <TierBadge tier={row.tier} />
                          </TableCell>
                          <TableCell className={`align-top ${row.parentKey ? "py-1.5" : ""}`}>
                            <StatusBadge status={row.status} source={row.source} />
                          </TableCell>
                          <TableCell className={`align-top ${row.parentKey ? "py-1.5" : ""}`}>
                            <ValueCell row={row} />
                          </TableCell>
                          <TableCell className={`align-top ${row.parentKey ? "py-1.5" : ""}`}>
                            <UnlockCell row={row} />
                          </TableCell>
                          <TableCell className={`align-top text-right tabular-nums ${row.parentKey ? "py-1.5" : ""}`}>
                            {typeof row.confidence === "number" ? (
                              `${Math.round(row.confidence * 100)}%`
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. API 트레이스 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API 트레이스</CardTitle>
              <CardDescription>provider별 캐시 행 · 원본/정규화 응답</CardDescription>
            </CardHeader>
            <CardContent>
              {result.trace.length === 0 ? (
                <p className="text-sm text-muted-foreground">기록된 캐시 행이 없습니다.</p>
              ) : (
                <Accordion multiple>
                  {result.trace.map((entry) => (
                    <TraceRow key={`${entry.provider}:${entry.scope}`} entry={entry} />
                  ))}
                </Accordion>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* 4. Q&A 섹션 */}
      <QnaSection qna={qna} setQna={setQna} disabled={!result} schema={qnaSchema} />

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>캐시를 비울까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {activeBizNo ? `${maskLocal(activeBizNo)} 의 ` : ""}저장된 {providerLabel(provider)} 캐시 행을
              삭제합니다.
              {provider === "apick" ? " Apick 라이브 조회 횟수 보호 기록은 유지됩니다." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onClearCache()} disabled={clearing}>
              {clearing ? "삭제 중…" : "캐시 비우기"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

// ── 커버리지 요약(몇 축이 채워지나 + 왜) ─────────────────────────────────────

function CoverageOverview({
  overview,
  reasonGroups,
  statusFilter,
  onFilter,
  maskedBizNo,
  subject,
}: {
  overview: CoverageOverviewData;
  reasonGroups: ReasonGroup[];
  statusFilter: StatusGroup | "all";
  onFilter: (next: StatusGroup | "all") => void;
  maskedBizNo: string;
  subject: ServiceDataLookupResult["subject"];
}) {
  const segments = STATUS_GROUPS.map((group) => ({ group, count: overview.counts[group] })).filter(
    (segment) => segment.count > 0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">매칭 필드 커버리지</CardTitle>
        <CardDescription>
          {maskedBizNo} · {subjectLabel(subject)} · 운영 구조화 19축은 아래 지표로, 하위 플래그는 별도
          진단 행으로 집계합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <CoverageMetric
            label="API 확정"
            metric={overview.metrics.authoritative_axis_coverage}
            description="공식 API·공개명단으로 complete인 부모축"
          />
          <CoverageMetric
            label="전체 판정 가능"
            metric={overview.metrics.total_answered_coverage}
            description="인증 입력·자가응답·파생값까지 포함"
          />
          <CoverageMetric
            label="공고 가중"
            metric={overview.metrics.grant_weighted_coverage}
            description={
              overview.hasGrantWeights
                ? "활성·검수 공고 criterion 빈도 가중"
                : "공고 가중치 없음 · 19축 균등 가중"
            }
          />
        </div>

        <span className="text-xs text-muted-foreground">
          상세 진단 행: 적용 대상 {overview.applicable}개 · 해당없음 {overview.counts.na}개 = 총 {overview.total}개
        </span>

        {/* 상태 구성 세그먼트 바 */}
        <div
          className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={STATUS_GROUPS.map(
            (group) => `${GROUP_META[group].label} ${overview.counts[group]}`,
          ).join(", ")}
        >
          {segments.map((segment) => (
            <div
              key={segment.group}
              className={GROUP_META[segment.group].dot}
              style={{ width: `${(segment.count / overview.total) * 100}%` }}
              title={`${GROUP_META[segment.group].label} ${segment.count}`}
            />
          ))}
        </div>

        {/* 범례 겸 필터 칩 */}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">
            색을 눌러 아래 표를 필터 · 확보·자가신고 = 채워짐, 대기·실패 = 빈 값, 해당없음 = 대상 아님
          </span>
          <div className="flex flex-wrap gap-2">
            <FilterChip
              active={statusFilter === "all"}
              onClick={() => onFilter("all")}
              dot="bg-foreground"
              label="전체"
              count={overview.total}
            />
            {STATUS_GROUPS.map((group) => (
              <FilterChip
                key={group}
                active={statusFilter === group}
                onClick={() => onFilter(group)}
                dot={GROUP_META[group].dot}
                label={GROUP_META[group].label}
                count={overview.counts[group]}
                meaning={GROUP_META[group].meaning}
              />
            ))}
          </div>
        </div>

        {/* 채워지고 · 안 채워지는 이유 — 근거별 묶음 */}
        <Accordion defaultValue={["reasons"]}>
          <AccordionItem value="reasons">
            <AccordionTrigger>
              <span className="text-sm font-medium">필드가 채워지고 · 안 채워지는 이유 (근거별 묶음)</span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="flex flex-col gap-2.5">
                {reasonGroups.map((reasonGroup) => (
                  <li
                    key={reasonGroup.reason}
                    className={`flex flex-col gap-1 border-l-2 pl-3 ${GROUP_META[reasonGroup.group].border}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-block size-2 shrink-0 rounded-full ${GROUP_META[reasonGroup.group].dot}`}
                        aria-hidden
                      />
                      <span className="text-sm font-medium">{reasonGroup.reason}</span>
                      <Badge variant="outline" className="tabular-nums">
                        {reasonGroup.labels.length}축
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{reasonGroup.labels.join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  dot,
  label,
  count,
  meaning,
}: {
  active: boolean;
  onClick: () => void;
  dot: string;
  label: string;
  count: number;
  meaning?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      className="h-8 gap-1.5"
      onClick={onClick}
      {...(meaning ? { title: meaning } : {})}
    >
      <span className={`inline-block size-2 rounded-full ${dot}`} aria-hidden />
      <span>{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </Button>
  );
}

function CoverageMetric({
  label,
  metric,
  description,
}: {
  label: string;
  metric: AutofillCoverageMetrics["authoritative_axis_coverage"];
  description: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums">{Math.round(metric.ratio * 100)}%</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMetricNumber(metric.numerator)} / {formatMetricNumber(metric.denominator)}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function formatMetricNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("ko-KR")
    : value.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

// ── 커버리지 셀 렌더 ──────────────────────────────────────────────────────────

function ValueCell({ row }: { row: MergedCoverageRow }) {
  const hasKnown = (row.knownFlagLabels?.length ?? 0) > 0;
  return (
    <div className="flex flex-col gap-1">
      {row.value ? (
        // 값은 줄바꿈 허용 — 잘리지 않고 셀 안에서 감긴다(왜 잘렸었나: 넓은 계획소스·상태 컬럼이 밀어냄).
        <span className="text-sm break-words whitespace-normal">{row.value}</span>
      ) : (
        // 빈 값의 "왜"는 옆 '채워지는 조건' 컬럼으로 이동했으므로 여기선 대시만.
        <span className="text-xs text-muted-foreground">{row.status === "n/a" ? "대상 아님" : "—"}</span>
      )}
      {hasKnown ? <KnownFlags known={row.knownFlagLabels ?? []} present={row.presentFlagLabels ?? []} exceptions={row.exceptionLabels ?? []} /> : null}
    </div>
  );
}

// '채워지는 조건 · 근거' 셀 — 채워진 행은 출처를, 안 채워진 행은 "어떤 남은 작업이 채우나"를,
// 자가신고 가능한 축은 챗봇이 물어볼 질문 예시를 함께 보여준다.
function UnlockCell({ row }: { row: MergedCoverageRow }) {
  const group = statusGroupOf(row.status);
  const question = row.selfDeclarable ? SELF_DECLARE_QUESTIONS[row.key] : undefined;

  if (group === "live") {
    return (
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span className="text-foreground/70">{row.note ?? `확보 · ${sourceRefLabel(row.source)}`}</span>
        <span>
          원천 종류: {sourceKindLabel(row.sourceKind)} · provider: {sourceRefLabel(row.source)} · 기준일:{" "}
          {formatDate(row.asOf)}
        </span>
        <span>축 완전성: {axisCompletenessLabel(row.axisCompleteness)}</span>
        <span className="opacity-70">계획 소스: {row.plannedSource}</span>
      </div>
    );
  }
  if (group === "self") {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-success">자가신고로 채움</span>
        <span className="text-muted-foreground">
          원천 종류: {sourceKindLabel(row.sourceKind)} · 기준일: {formatDate(row.asOf)} · 축 완전성:{" "}
          {axisCompletenessLabel(row.axisCompleteness)}
        </span>
        {question ? <ChatQuestion question={question} /> : null}
      </div>
    );
  }
  if (group === "na") {
    return <span className="text-xs text-muted-foreground">{row.note ?? "대상 아님"}</span>;
  }

  // pending / failed — 어떤 남은 작업이 구현되면 채워지나.
  const kind = classifyUnlock(row);
  const meta = UNLOCK_META[kind];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={`${meta.border} ${meta.text} whitespace-nowrap`}>
          {meta.label}
        </Badge>
        <span className="text-xs text-muted-foreground">{unlockDetail(row, kind)}</span>
      </div>
      <span className="text-[11px] text-muted-foreground/80">계획 소스: {row.plannedSource}</span>
      {question ? <ChatQuestion question={question} prefix={kind === "self" ? "챗봇 질문 예시" : "또는 자가신고"} /> : null}
    </div>
  );
}

function ChatQuestion({ question, prefix = "챗봇 질문 예시" }: { question: string; prefix?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-1 text-xs">
      <span className="shrink-0 text-success">{prefix}</span>
      <span className="text-muted-foreground italic">“{question}”</span>
    </span>
  );
}

function KnownFlags({ known, present, exceptions }: { known: string[]; present: string[]; exceptions: string[] }) {
  const presentSet = new Set(present);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-muted-foreground">확인 플래그:</span>
      {known.map((label) =>
        presentSet.has(label) ? (
          <Badge key={label} variant="destructive" className="px-1.5 py-0 text-[10px]">
            {label} 보유
          </Badge>
        ) : (
          <Badge key={label} variant="outline" className="border-success/40 px-1.5 py-0 text-[10px] text-success">
            {label}
          </Badge>
        ),
      )}
      {exceptions.map((label) => (
        <Badge key={`ex-${label}`} variant="outline" className="border-primary/40 px-1.5 py-0 text-[10px] text-primary">
          예외: {label}
        </Badge>
      ))}
    </div>
  );
}

function TierBadge({ tier }: { tier: FieldTier }) {
  if (tier === "A") return <Badge variant="outline" className="border-primary/40 text-primary">A층</Badge>;
  if (tier === "B") return <Badge variant="outline" className="text-muted-foreground">B층</Badge>;
  return <Badge variant="secondary" className="text-muted-foreground">예약</Badge>;
}

// 컴팩트 상태 배지 — 사유(note)는 옆 '채워지는 조건' 컬럼이 맡으므로 여기선 상태만 짧게.
function StatusBadge({ status, source }: { status: FieldCoverageStatus; source: FieldSourceRef | null }) {
  if (status === "live") {
    return <Badge className="bg-primary text-primary-foreground whitespace-nowrap">라이브 · {sourceRefLabel(source)}</Badge>;
  }
  if (status === "cache") {
    return <Badge variant="secondary" className="whitespace-nowrap">캐시 · {sourceRefLabel(source)}</Badge>;
  }
  if (status === "self-declared") {
    return <Badge variant="outline" className="border-success/50 text-success">자가신고</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive">실패</Badge>;
  }
  if (status === "n/a") {
    return <Badge variant="secondary" className="whitespace-nowrap text-muted-foreground">해당 없음</Badge>;
  }
  // pending — 범례의 amber(warning)와 일치시켜 "아직 빈 값"임을 색으로 신호한다.
  return (
    <Badge variant="outline" className="border-dashed border-warning/50 text-warning">
      대기
    </Badge>
  );
}

function sourceRefLabel(source: FieldSourceRef | null): string {
  if (source === "popbill") return "팝빌";
  if (source === "apick") return "Apick";
  if (source === "nts") return "국세청";
  if (source === "smpp") return "공공구매망";
  if (source === "kcomwel") return "근로복지공단";
  if (source === "fsc") return "금융위";
  if (source === "nice") return "NICE";
  if (source === "codef") return "국세청(CODEF)";
  if (source === "derived") return "추론";
  return "—";
}

function sourceKindLabel(sourceKind: EvidenceSourceKind | null): string {
  if (sourceKind === "authoritative_api") return "공식 API";
  if (sourceKind === "public_registry") return "공개명단";
  if (sourceKind === "auth_supplied") return "인증 과정 입력";
  if (sourceKind === "self_declared") return "사용자 응답";
  if (sourceKind === "derived") return "파생값";
  return "—";
}

function axisCompletenessLabel(value: FieldCoverageRow["axisCompleteness"]): string {
  if (value === "complete") return "전체 판정 가능";
  if (value === "partial") return "일부만 확인";
  if (value === "not_applicable") return "해당 없음";
  return "미확정";
}

function subjectLabel(subject: ServiceDataLookupResult["subject"]): string {
  if (subject === "corporation") return "법인(추론)";
  if (subject === "individual") return "개인사업자(추론)";
  return "유형 미상";
}

// entry 는 조회 사이 불변이라 memo 로 Q&A 타이핑 등 상위 리렌더에서 payload 재직렬화를 차단한다.
const TraceRow = memo(function TraceRow({ entry }: { entry: ServiceDataTraceEntry }) {
  return (
    <AccordionItem value={`${entry.provider}:${entry.scope}`}>
      <AccordionTrigger>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {providerLabel(entry.provider)} · {entry.scope}
          </span>
          <OriginBadge origin={entry.origin} />
          {entry.expired ? <Badge variant="destructive">만료</Badge> : null}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            <Meta label="checkedAt" value={formatDate(entry.checkedAt)} />
            <Meta label="fetchedAt" value={formatDate(entry.fetchedAt)} />
            <Meta label="expiresAt" value={formatDate(entry.expiresAt)} />
            <Meta label="resultCode" value={entry.resultCode ?? "—"} />
            <Meta label="resultMessage" value={entry.resultMessage ?? "—"} />
          </dl>
          <Separator />
          <PayloadTabs raw={entry.rawPayload} canonical={entry.canonicalPayload} />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
});

function PayloadTabs({
  raw,
  canonical,
}: {
  raw: Record<string, unknown> | null;
  canonical: Record<string, unknown> | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <JsonBlock label="canonical (정규화)" value={canonical} />
      <JsonBlock label="raw (원본 응답)" value={raw} />
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  // 수 KB payload 를 매 리렌더마다 재직렬화하지 않는다.
  const text = useMemo(() => (value ? JSON.stringify(value, null, 2) : "null"), [value]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {/* ScrollArea 뷰포트는 height:100%로 부모 높이를 상속받아 스크롤을 계산하므로,
          max-height가 아닌 고정 height를 줘야 실제로 세로 스크롤이 걸린다. */}
      <ScrollArea className="h-72 w-full rounded-md border border-border bg-muted/40">
        <pre className="w-max min-w-full overflow-x-auto p-3 text-xs leading-relaxed">{text}</pre>
      </ScrollArea>
    </div>
  );
}

// ── Q&A (자가신고) ────────────────────────────────────────────────────────────

function QnaSection({
  qna,
  setQna,
  disabled,
  schema,
}: {
  qna: QnaState;
  setQna: React.Dispatch<React.SetStateAction<QnaState>>;
  disabled: boolean;
  schema: QnaSchema;
}) {
  const toggleInArray = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">자가신고 (Q&A)</CardTitle>
        <CardDescription>
          API로 확보할 수 없어 사용자에게 받아야 하는 축입니다. 입력하면 위 커버리지 대시보드에 즉시
          병합됩니다(서버 저장 없음, 모니터 확인용). 결격 3축은 그룹 체크리스트로 확인 시 해당 플래그가
          known_flags로 채워집니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <QnaField
          id="qna-birth-year"
          label="대표자 출생연도"
          hint="국세청·팝빌 응답에 생년 정보가 없습니다."
        >
          <Input
            id="qna-birth-year"
            type="number"
            inputMode="numeric"
            placeholder="예: 1985"
            value={qna.birthYear}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, birthYear: event.target.value }))}
          />
          {computeAge(qna.birthYear) !== null ? (
            <span className="text-xs text-muted-foreground">만 {computeAge(qna.birthYear)}세</span>
          ) : null}
        </QnaField>

        <QnaField
          label="대표자 특성"
          hint="공공 API는 여성·장애인만 커버하며 청년·시니어는 알 수 없습니다."
        >
          <CheckboxGroup
            options={TRAIT_OPTIONS}
            selected={qna.traits}
            disabled={disabled}
            name="trait"
            onToggle={(value) => setQna((prev) => ({ ...prev, traits: toggleInArray(prev.traits, value) }))}
          />
        </QnaField>

        <QnaField id="qna-employees" label="상시근로자 수" hint="공공 API에 상시근로자 수 응답이 없습니다.">
          <Input
            id="qna-employees"
            type="number"
            inputMode="numeric"
            placeholder="예: 12"
            value={qna.employees}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, employees: event.target.value }))}
          />
        </QnaField>

        <QnaField
          id="qna-revenue-eok"
          label="직전 연도 매출 (억원)"
          hint="개인사업자 매출은 공공 API가 없습니다(홈택스 동의 필요)."
        >
          <Input
            id="qna-revenue-eok"
            type="number"
            inputMode="decimal"
            placeholder="예: 3.5"
            value={qna.revenueEok}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, revenueEok: event.target.value }))}
          />
        </QnaField>

        <QnaField
          label="보유 인증·확인서"
          hint="공공구매망은 여성·장애인 확인서만 조회되며 벤처·이노비즈 등은 알 수 없습니다."
        >
          <CheckboxGroup
            options={CERT_OPTIONS}
            selected={qna.certs}
            disabled={disabled}
            name="cert"
            onToggle={(value) => setQna((prev) => ({ ...prev, certs: toggleInArray(prev.certs, value) }))}
          />
        </QnaField>

        <QnaField
          id="qna-prior-award"
          label="정책자금·지원사업 수혜 이력"
          hint="수혜 이력은 통합 공개 API가 없습니다."
        >
          <Textarea
            id="qna-prior-award"
            placeholder="예: 2024 창업도약패키지 선정"
            value={qna.priorAward}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, priorAward: event.target.value }))}
          />
        </QnaField>

        <QnaField id="qna-ip-count" label="특허·지재권 보유 건수" hint="KIPRIS 매칭은 별도 확인이 필요합니다.">
          <Input
            id="qna-ip-count"
            type="number"
            inputMode="numeric"
            placeholder="예: 2"
            value={qna.ipCount}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, ipCount: event.target.value }))}
          />
        </QnaField>

        <QnaField label="예비창업자 여부" hint="사업자 미등록 상태는 공공 API로 확인할 수 없습니다.">
          <Label htmlFor="qna-preliminary" className="font-normal">
            <Checkbox
              id="qna-preliminary"
              checked={qna.isPreliminary}
              disabled={disabled}
              onCheckedChange={(checked) => setQna((prev) => ({ ...prev, isPreliminary: checked === true }))}
            />
            예비창업자입니다
          </Label>
        </QnaField>

        <Separator />

        {/* 결격 3축 그룹 체크리스트 */}
        <div className="flex flex-col gap-1">
          <Label>결격 빠른 확인</Label>
          <p className="text-xs text-muted-foreground">
            각 그룹을 확인하면 해당 canonical 플래그가 known_flags로 채워집니다("해당사항 확인"만 체크하면
            결격 없음, 개별 항목 체크 시 해당 플래그 보유). 결격은 부재가 신호라 소진적 확인이 곧 pass 근거입니다.
          </p>
        </div>
        {schema.disqualification.map((axis) => (
          <div key={axis.axis} className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <span className="text-sm font-medium">{axis.label}</span>
            {axis.questions.map((group) => (
              <DisqGroup
                key={group.id}
                group={group}
                confirmed={Boolean(qna.disqConfirmed[group.id])}
                flags={qna.disqFlags[group.id] ?? []}
                disabled={disabled}
                onConfirm={(checked) =>
                  setQna((prev) => ({ ...prev, disqConfirmed: { ...prev.disqConfirmed, [group.id]: checked } }))
                }
                onToggleFlag={(flag) =>
                  setQna((prev) => ({
                    ...prev,
                    disqFlags: { ...prev.disqFlags, [group.id]: toggleInArray(prev.disqFlags[group.id] ?? [], flag) },
                  }))
                }
              />
            ))}
          </div>
        ))}

        <QnaField label="결격 예외 사유" hint="유예·성실이행·시효완성 등은 플래그 단위로 결격을 면제합니다.">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {schema.exceptions.map((exception) => {
              const id = `qna-exception-${exception.key}`;
              return (
                <Label key={exception.key} htmlFor={id} className="font-normal">
                  <Checkbox
                    id={id}
                    checked={qna.disqExceptions.includes(exception.key)}
                    disabled={disabled}
                    onCheckedChange={() =>
                      setQna((prev) => ({ ...prev, disqExceptions: toggleInArray(prev.disqExceptions, exception.key) }))
                    }
                  />
                  {exception.label}
                </Label>
              );
            })}
          </div>
        </QnaField>

        <Separator />

        {/* 재무건전성 */}
        <QnaField label="재무건전성 — 자본잠식 여부" hint="법인 재무는 금융위 재무 V2로 자동 파생 예정(Phase 2). 지금은 자가신고.">
          <SegmentedChoice
            value={qna.capitalImpairment}
            disabled={disabled}
            options={[
              { value: "none", label: "없음" },
              { value: "partial", label: "부분잠식" },
              { value: "full", label: "완전잠식" },
            ]}
            onChange={(value) => setQna((prev) => ({ ...prev, capitalImpairment: value as QnaState["capitalImpairment"] }))}
          />
        </QnaField>

        <QnaField id="qna-equity-eok" label="자본총계 (억원, 선택)" hint="자본총계를 입력하면 자본잠식 파생 근거로 확인됩니다.">
          <Input
            id="qna-equity-eok"
            type="number"
            inputMode="decimal"
            placeholder="예: 12.5"
            value={qna.equityEok}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, equityEok: event.target.value }))}
          />
        </QnaField>

        <Separator />

        {/* 고용 */}
        <QnaField label="고용 — 감원 이력" hint="감원 이력(무감원 요건)은 자동 소스가 없어 자가신고가 상한입니다.">
          <SegmentedChoice
            value={qna.noLayoff}
            disabled={disabled}
            options={[
              { value: "yes", label: "감원 없음" },
              { value: "no", label: "감원 있음" },
            ]}
            onChange={(value) => setQna((prev) => ({ ...prev, noLayoff: value as QnaState["noLayoff"] }))}
          />
          {qna.noLayoff === "no" ? (
            <div className="flex items-center gap-2">
              <Input
                id="qna-layoff-months"
                type="number"
                inputMode="numeric"
                placeholder="예: 8"
                className="w-24"
                value={qna.layoffMonths}
                disabled={disabled}
                onChange={(event) => setQna((prev) => ({ ...prev, layoffMonths: event.target.value }))}
              />
              <span className="text-xs text-muted-foreground">
                마지막 감원 후 경과 개월 — 미입력 시 매칭은 unknown(감원 시점 입력 필요)
              </span>
            </div>
          ) : null}
        </QnaField>

        <Separator />

        {/* 투자 */}
        <QnaField id="qna-investment-eok" label="누적 투자유치금 (억원)" hint="투자금·라운드는 공개 통합 API가 없습니다.">
          <Input
            id="qna-investment-eok"
            type="number"
            inputMode="decimal"
            placeholder="예: 20"
            value={qna.investmentEok}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, investmentEok: event.target.value }))}
          />
        </QnaField>

        <QnaField id="qna-investment-round" label="최근 투자 라운드" hint="예: seed / pre-A / Series A">
          <Input
            id="qna-investment-round"
            placeholder="예: Series A"
            value={qna.investmentRound}
            disabled={disabled}
            onChange={(event) => setQna((prev) => ({ ...prev, investmentRound: event.target.value }))}
          />
        </QnaField>

        <QnaField label="TIPS 선정 여부" hint="TIPS 선정기업 명단은 배치 퍼지매칭 예정(Phase 2). 지금은 자가신고.">
          <Label htmlFor="qna-tips" className="font-normal">
            <Checkbox
              id="qna-tips"
              checked={qna.tipsBacked}
              disabled={disabled}
              onCheckedChange={(checked) => setQna((prev) => ({ ...prev, tipsBacked: checked === true }))}
            />
            TIPS 선정기업입니다
          </Label>
        </QnaField>
      </CardContent>
    </Card>
  );
}

function DisqGroup({
  group,
  confirmed,
  flags,
  disabled,
  onConfirm,
  onToggleFlag,
}: {
  group: QnaSchema["disqualification"][number]["questions"][number];
  confirmed: boolean;
  flags: string[];
  disabled: boolean;
  onConfirm: (checked: boolean) => void;
  onToggleFlag: (flag: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{group.label}</span>
        <Label htmlFor={`qna-confirm-${group.id}`} className="font-normal text-xs">
          <Checkbox
            id={`qna-confirm-${group.id}`}
            checked={confirmed}
            disabled={disabled}
            onCheckedChange={(checked) => onConfirm(checked === true)}
          />
          해당사항 확인 (문제 없으면 체크)
        </Label>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {group.flags.map((flag) => {
          const id = `qna-flag-${flag.flag}`;
          return (
            <Label key={flag.flag} htmlFor={id} className="font-normal">
              <Checkbox
                id={id}
                checked={flags.includes(flag.flag)}
                disabled={disabled}
                onCheckedChange={() => onToggleFlag(flag.flag)}
              />
              {flag.label} 보유
            </Label>
          );
        })}
      </div>
    </div>
  );
}

function SegmentedChoice({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex w-fit rounded-md border border-border bg-muted/40 p-1">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={value === option.value ? "default" : "ghost"}
          className="h-8"
          disabled={disabled}
          // 같은 값을 다시 누르면 선택 해제(미상으로 되돌림).
          onClick={() => onChange(value === option.value ? "" : option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function QnaField({
  id,
  label,
  hint,
  children,
}: {
  /** 단일 입력 컨트롤과 라벨을 연결할 때 지정(체크박스 그룹은 항목별 라벨이 이미 연결돼 있어 생략). */
  id?: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label {...(id ? { htmlFor: id } : {})}>{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-col gap-2 pt-1">{children}</div>
    </div>
  );
}

function CheckboxGroup({
  options,
  selected,
  onToggle,
  disabled,
  name,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  disabled: boolean;
  name: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {options.map((option) => {
        const id = `qna-${name}-${option}`;
        return (
          <Label key={option} htmlFor={id} className="font-normal">
            <Checkbox
              id={id}
              checked={selected.includes(option)}
              disabled={disabled}
              onCheckedChange={() => onToggle(option)}
            />
            {option}
          </Label>
        );
      })}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium break-all">{value}</dd>
    </div>
  );
}

function OriginBadge({ origin }: { origin: "live" | "cache" | null }) {
  if (!origin) return <span className="text-muted-foreground">—</span>;
  if (origin === "live") return <Badge>라이브 호출</Badge>;
  return <Badge variant="secondary">캐시 재사용</Badge>;
}

function LookupSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// ── 순수 헬퍼 ────────────────────────────────────────────────────────────────

// 6개 서버 상태(live/cache/self-declared/pending/failed/n-a)를 화면 5색 그룹으로 접는다.
// 색 언어: 확보·자가신고=채워짐(초록/파랑), 대기·실패=빈 값(노랑/빨강), 해당없음=대상 아님(회색).
const STATUS_GROUPS = ["live", "self", "pending", "failed", "na"] as const;
type StatusGroup = (typeof STATUS_GROUPS)[number];

const GROUP_META: Record<
  StatusGroup,
  { label: string; meaning: string; dot: string; text: string; border: string }
> = {
  live: {
    label: "확보",
    meaning: "외부 소스에서 실제 값을 받아 채워짐",
    dot: "bg-primary",
    text: "text-primary",
    border: "border-primary/50",
  },
  self: {
    label: "자가신고",
    meaning: "API로 얻을 수 없어 사용자 입력(Q&A)으로 채워짐",
    dot: "bg-success",
    text: "text-success",
    border: "border-success/50",
  },
  pending: {
    label: "대기",
    meaning: "아직 빈 값 — 소스 미배선·API 키 대기·자가신고 대기",
    dot: "bg-warning",
    text: "text-warning",
    border: "border-warning/50",
  },
  failed: {
    label: "실패",
    meaning: "조회했으나 에러·빈값·스키마 불일치로 못 채움",
    dot: "bg-destructive",
    text: "text-destructive",
    border: "border-destructive/50",
  },
  na: {
    label: "해당 없음",
    meaning: "예약축이거나 개인사업자 대상이 아닌 법인 전용축",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    border: "border-border",
  },
};

function statusGroupOf(status: FieldCoverageStatus): StatusGroup {
  if (status === "live" || status === "cache") return "live";
  if (status === "self-declared") return "self";
  if (status === "failed") return "failed";
  if (status === "n/a") return "na";
  return "pending";
}

interface CoverageOverviewData {
  /** 전체 행 수(22축 + 하위 플래그·서브필드). */
  total: number;
  /** 적용 대상(전체 − 해당없음). 커버리지율의 분모. */
  applicable: number;
  /** 지금 값이 채워진 축(확보 + 자가신고). */
  filled: number;
  counts: Record<StatusGroup, number>;
  metrics: AutofillCoverageMetrics;
  hasGrantWeights: boolean;
}

function summarizeCoverage(
  rows: MergedCoverageRow[],
  grantWeights: AutofillGrantWeights | null,
): CoverageOverviewData {
  const counts: Record<StatusGroup, number> = { live: 0, self: 0, pending: 0, failed: 0, na: 0 };
  for (const row of rows) counts[statusGroupOf(row.status)] += 1;
  const total = rows.length;
  const applicable = total - counts.na;
  const filled = counts.live + counts.self;
  return {
    total,
    applicable,
    filled,
    counts,
    metrics: measureAutofillCoverage(rows, grantWeights),
    hasGrantWeights: grantWeights !== null,
  };
}

interface ReasonGroup {
  reason: string;
  group: StatusGroup;
  labels: string[];
}

/** 행의 status + note 를 사람이 읽는 한 줄 사유로 환원한다(왜 채워졌나 / 왜 안 채워졌나). */
function reasonOf(row: MergedCoverageRow): string {
  const group = statusGroupOf(row.status);
  if (group === "live") return `확보 · ${sourceRefLabel(row.source)}`;
  if (group === "self") return "자가신고로 채움";
  if (group === "failed") return "조회 실패 · 응답 이상";
  if (group === "na") {
    if (row.note?.includes("예약")) return "예약축 · 추후 배선";
    return "법인 전용축 · 개인사업자 대상 아님";
  }
  // pending — 계획 소스·note 키워드로 사유를 버킷팅.
  const note = row.note ?? "";
  if (row.plannedSource.includes("CODEF 간편인증")) return "CODEF 간편인증 완료 시 채워짐";
  // "미배선"(라이브 소스가 값 미제공)은 "배선" 부분문자열보다 먼저 걸러야 커넥터 대기로 오분류되지 않는다.
  if (note.includes("미배선")) return "소스 응답에 값 없음 · 응답 포함 시 자동 채움";
  if (note.includes("배치")) return "배치 파이프라인 · Phase 2 배선 예정";
  if (note.includes("개인")) return "개인사업자 통합 소스 없음 · 자가신고 필요";
  if (note.includes("법인등록번호")) return "법인번호 브리지 필요 · apick 조회 경로에서만";
  if (note.includes("키 있음")) return "API 키 있음 · 커넥터 Phase 2 배선 대기";
  if (note.includes("키 없음")) return "외부 API 키 미설정";
  if (note.includes("커넥터") || note.includes("배선")) return "커넥터 Phase 2 배선 대기";
  return "자동 소스 없음 · 자가신고 대기";
}

/** 사유별로 축을 묶고 상태 그룹 순서(확보→자가신고→대기→실패→해당없음), 건수 desc 로 정렬. */
function groupByReason(rows: MergedCoverageRow[]): ReasonGroup[] {
  const byReason = new Map<string, ReasonGroup>();
  for (const row of rows) {
    const reason = reasonOf(row);
    const existing = byReason.get(reason);
    if (existing) existing.labels.push(row.label);
    else byReason.set(reason, { reason, group: statusGroupOf(row.status), labels: [row.label] });
  }
  const order = new Map<StatusGroup, number>(STATUS_GROUPS.map((group, index) => [group, index]));
  return [...byReason.values()].sort((a, b) => {
    const byGroup = (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0);
    return byGroup !== 0 ? byGroup : b.labels.length - a.labels.length;
  });
}

// ── 채워지는 조건: 안 채워진 축을 "어떤 남은 작업이 채우나" 로 분류 ──────────────
// 남은 작업 축(코드 실측 기준):
//   key         = 외부 API 서비스키 발급·설정(근로복지공단·금융위·NICE·KIPRIS·중대재해)
//   simple-auth = CODEF 간편인증(사용자 휴대폰 승인 → 국세청 확정값 passive read)
//   connector   = 키는 있으나 커넥터 Phase 2 배선 미완
//   batch       = 명단 배치 파이프라인(조달청 CSV·체불·중대재해·TIPS 명단)
//   apick       = 금융위 법인재무: apick 경로의 법인등록번호 브리지 필요
//   self        = 공개·자동 소스 없음 → 자가신고(챗봇)
//   source      = 라이브 소스가 이번 응답에 값을 안 실음(데이터 가용성)
//   failed      = 조회는 됐으나 에러·빈값·스키마 불일치
type UnlockKind = "key" | "simple-auth" | "connector" | "batch" | "apick" | "self" | "source" | "failed";

const UNLOCK_META: Record<UnlockKind, { label: string; border: string; text: string }> = {
  key: { label: "API 키 발급", border: "border-primary/40", text: "text-primary" },
  "simple-auth": { label: "CODEF 간편인증", border: "border-primary/40", text: "text-primary" },
  connector: { label: "커넥터 배선(P2)", border: "border-primary/40", text: "text-primary" },
  batch: { label: "명단 배치 파이프라인", border: "border-primary/40", text: "text-primary" },
  apick: { label: "apick 조회 경로", border: "border-primary/40", text: "text-primary" },
  self: { label: "자가신고(챗봇)", border: "border-success/50", text: "text-success" },
  source: { label: "소스 응답 대기", border: "border-warning/50", text: "text-warning" },
  failed: { label: "응답 이상", border: "border-destructive/50", text: "text-destructive" },
};

function classifyUnlock(row: MergedCoverageRow): UnlockKind {
  if (statusGroupOf(row.status) === "failed") return "failed";
  const note = row.note ?? "";
  const source = row.plannedSource;
  if (source.includes("CODEF 간편인증")) return "simple-auth";
  // "미배선"은 라이브 소스가 값을 안 실은 경우(예: 기업규모) — "배선" 부분문자열 매칭보다 먼저 걸러야 한다.
  if (note.includes("미배선")) return "source";
  if (note.includes("배치")) return "batch";
  if (note.includes("법인등록번호")) return "apick";
  if (note.includes("키 있음")) return "connector";
  if (note.includes("키 없음")) return "key";
  if (note.includes("커넥터") || note.includes("배선")) return "connector";
  if (note.includes("개인")) return "self";
  if (row.selfDeclarable) return "self";
  return "source";
}

function unlockDetail(row: MergedCoverageRow, kind: UnlockKind): string {
  switch (kind) {
    case "failed":
      return row.note ?? "원천 응답 확인 필요";
    case "simple-auth":
      return "사용자 휴대폰 간편인증 완료 시 국세청 확정값으로 채워짐";
    case "connector":
      return "API 키는 있음 · 커넥터 Phase 2 배선 완료 시 채워짐";
    case "key":
      return "해당 소스 서비스키 발급·설정 시 자동으로 채워짐";
    case "batch":
      return "명단 수집 배치(사업자번호·상호 매칭) 구축 시 채워짐";
    case "apick":
      return "apick 조회 경로로 실행 시 법인등록번호가 브리지되어 채워짐";
    case "self":
      return "공개·자동 소스가 없어 자가신고로 채움";
    case "source":
      return "계획 소스 응답에 값이 포함되면 자동으로 채워짐";
  }
}

// 자가신고 축(FIELD_COVERAGE_PLAN 의 selfDeclarable=true)을 챗봇이 대화체로 물어볼 질문 예시.
// row.key 로 매핑(축·하위 플래그·서브필드 모두). 값 확보 경로가 막혔을 때 사용자에게 직접 받는다.
const SELF_DECLARE_QUESTIONS: Record<string, string> = {
  // ── A/B층 프로필 축 ──
  revenue: "직전 회계연도 매출액이 대략 얼마였나요? (억원 단위로 편하게 알려주세요)",
  employees: "현재 4대보험에 가입된 상시근로자는 몇 명인가요?",
  founder_age: "대표자님은 몇 년생이세요? (출생연도만 알려주셔도 돼요)",
  founder_trait:
    "대표자님이 여성, 청년(만 39세 이하), 시니어(만 60세 이상), 장애인 중 해당되는 게 있으신가요?",
  certification:
    "보유하신 기업 인증·확인서가 있나요? (예: 벤처기업, 이노비즈, 메인비즈, 기업부설연구소, 여성·장애인기업)",
  prior_award:
    "최근 3년 안에 정부 지원사업이나 정책자금을 받으신 적이 있나요? 있다면 사업명과 연도를 알려주세요.",
  ip: "특허·실용신안·상표 같은 지식재산권을 보유하고 계신가요? 몇 건인지 알려주세요.",
  target_type: "사업자 등록을 이미 마치셨나요, 아니면 아직 준비 중인 예비창업자이신가요?",

  // ── 납세 결격 ──
  tax_compliance:
    "세금 체납이 있으신가요? 국세·지방세·관세·4대보험료 중 밀린 게 있으면 알려주세요. 없으면 '없음'이라고 답해 주세요.",
  "tax_compliance.national_tax_delinquent": "국세(법인세·부가세·소득세 등)를 체납 중인 게 있으신가요?",
  "tax_compliance.local_tax_delinquent": "지방세(주민세·재산세 등)를 체납 중인 게 있으신가요?",
  "tax_compliance.customs_delinquent": "수입 관세를 체납 중인 게 있으신가요?",
  "tax_compliance.social_insurance_delinquent": "국민연금·건강보험 등 4대보험료가 밀려 있으신가요?",

  // ── 신용 결격 ──
  credit_status:
    "신용 관련 결격 사유가 있으신가요? (금융 연체, 채무불이행, 부도, 기업회생·파산·법정관리 등) 없으면 '없음'이라고 답해 주세요.",
  "credit_status.credit_delinquency": "금융기관 대출·카드 등에서 연체 중인 게 있으신가요?",
  "credit_status.loan_default": "대출금을 갚지 못해 채무불이행(대위변제 등) 상태인 게 있으신가요?",
  "credit_status.bond_default": "발행한 어음·수표가 부도나 당좌거래가 정지된 적이 있나요?",
  "credit_status.rehabilitation_in_progress": "현재 기업회생(법정관리) 절차가 진행 중인가요?",
  "credit_status.bankruptcy_filed": "파산을 신청했거나 파산 절차가 진행 중인가요?",
  "credit_status.court_receivership": "법원 관리(법정관리·워크아웃)를 받고 계신가요?",
  "credit_status.financial_misconduct": "금융질서 문란(금융사고) 관련 등록 이력이 있으신가요?",
  "credit_status.asset_seizure": "회사 자산에 압류·가압류가 걸려 있나요?",
  "credit_status.guarantee_restricted": "신용보증기금·기술보증기금 등에서 보증제한을 받고 계신가요?",

  // ── 제재·명단 결격 ──
  sanction:
    "정부·공공사업 관련 제재나 명단 등재 이력이 있으신가요? (부정당업자 제재, 임금체불 명단, 중대재해, 보조금 부정수급 등) 없으면 '없음'이라고 답해 주세요.",
  "sanction.participation_restricted": "공공조달에서 부정당업자로 참가제한 제재를 받은 적이 있나요?",
  "sanction.wage_arrears_listed": "임금체불 사업주 명단에 오른 적이 있나요?",
  "sanction.serious_accident_listed": "중대재해가 발생했거나 명단이 공표된 적이 있나요?",
  "sanction.subsidy_fraud": "보조금을 부정하게 받아 제재된 이력이 있나요?",
  "sanction.subsidy_law_violation": "보조금 관리법을 위반한 이력이 있나요?",
  "sanction.obligation_breach": "지원사업의 의무 사항을 위반한 이력이 있나요?",
  "sanction.agreement_breach": "협약(약정) 위반으로 제재받은 이력이 있나요?",

  // ── 재무건전성 ──
  financial_health:
    "재무 상태를 여쭐게요. 현재 자본잠식 상태인가요? 자본총계(순자산)를 아시면 대략 얼마인지 알려주세요.",
  "financial_health.impairment":
    "현재 자본잠식(자본총계가 자본금보다 적은 상태)인가요? '없음/부분/완전' 중 하나로 알려주세요.",
  "financial_health.equity_krw": "재무제표상 자본총계(순자산)가 대략 얼마인가요? (억원)",

  // ── 고용보험 가입 ──
  insured_workforce: "고용 관련해서요. 최근 1년 안에 인위적인 감원(구조조정 해고)이 있었나요?",
  "insured_workforce.no_layoff": "최근 1년 안에 정리해고 등 인위적인 감원이 있었나요?",

  // ── 투자 유치 ──
  investment:
    "투자 유치 이력이 있으신가요? 누적 투자금, 최근 라운드(예: Seed·Series A), TIPS 선정 여부를 알려주세요.",
  "investment.tips_backed": "TIPS(민간투자주도형 기술창업지원)에 선정된 적이 있나요?",
  "investment.total_raised_krw": "지금까지 유치한 누적 투자금은 대략 얼마인가요? (억원)",
  "investment.last_round": "가장 최근에 진행한 투자 라운드는 무엇인가요? (예: Seed, Pre-A, Series A)",

  // ── 기타 ──
  other: "그 외에 지원 자격에 영향을 줄 만한 특이사항이 있으면 알려주세요.",
};

interface AxisQna {
  answered: boolean;
  complete: boolean;
  knownFlags: string[];
  presentFlags: string[];
}

/** 결격 문항 그룹 응답을 축 단위로 집계. answered 축은 그룹 covers 전체가 known_flags가 된다. */
function deriveDisqByAxis(
  qna: QnaState,
  schema: QnaSchema,
): { byAxis: Map<string, AxisQna>; flagLabel: Map<string, string> } {
  const flagLabel = new Map<string, string>();
  const byAxis = new Map<string, AxisQna>();
  for (const axis of schema.disqualification) {
    const known: string[] = [];
    const present: string[] = [];
    const allFlags = new Set<string>();
    let answered = false;
    for (const group of axis.questions) {
      for (const flag of group.flags) {
        flagLabel.set(flag.flag, flag.label);
        allFlags.add(flag.flag);
      }
      const groupFlags = qna.disqFlags[group.id] ?? [];
      const groupAnswered = Boolean(qna.disqConfirmed[group.id]) || groupFlags.length > 0;
      if (groupAnswered) {
        answered = true;
        for (const flag of group.flags) known.push(flag.flag);
        for (const flag of groupFlags) present.push(flag);
      }
    }
    const knownFlags = [...new Set(known)];
    byAxis.set(axis.axis, {
      answered,
      complete: allFlags.size > 0 && knownFlags.length === allFlags.size,
      knownFlags,
      presentFlags: [...new Set(present)],
    });
  }
  return { byAxis, flagLabel };
}

/**
 * 서버 커버리지(22축)에 Q&A 자가신고를 오버레이한다. 라이브/캐시/해당없음 행은 원천을 유지하고(회귀 금지),
 * pending/failed 행만 자가신고 값으로 self-declared 전환한다. 결격 3축은 {flags, known_flags, exceptions}를
 * 병합해 known_flags를 별도 라벨로 노출한다.
 */
function mergeFieldsWithQna(
  coverage: FieldCoverageRow[],
  qna: QnaState,
  schema: QnaSchema,
): MergedCoverageRow[] {
  const { byAxis, flagLabel } = deriveDisqByAxis(qna, schema);
  // 예외는 축 구분 없이 체크되지만, 표시는 EXCEPTION_FLAG_COVERAGE가 그 축의 플래그를 실제로
  // 면제할 때만 한다(계약의 축별 exceptions 시맨틱과 정합 — 무관한 축에 예외 배지 오표시 방지).
  const checkedExceptions = schema.exceptions.filter((exception) => qna.disqExceptions.includes(exception.key));
  const exceptionLabelsForAxis = (axisKey: string): string[] => {
    const axisFlags = new Set(
      schema.disqualification
        .find((axis) => axis.axis === axisKey)
        ?.questions.flatMap((group) => group.flags.map((flag) => flag.flag)) ?? [],
    );
    return checkedExceptions
      .filter((exception) => exception.flags.some((flag) => axisFlags.has(flag)))
      .map((exception) => exception.label);
  };

  const age = computeAge(qna.birthYear);
  const legacy: Record<string, string> = {};
  if (age !== null) legacy.founder_age = `만 ${age}세`;
  const employees = Number(qna.employees);
  if (qna.employees.trim() && Number.isFinite(employees)) legacy.employees = `${employees.toLocaleString("ko-KR")}명`;
  const revenueEok = Number(qna.revenueEok);
  if (qna.revenueEok.trim() && Number.isFinite(revenueEok)) legacy.revenue = `${revenueEok.toLocaleString("ko-KR")}억원`;
  if (qna.certs.length > 0) legacy.certification = qna.certs.join(", ");
  if (qna.traits.length > 0) legacy.founder_trait = qna.traits.join(", ");
  if (qna.priorAward.trim()) legacy.prior_award = qna.priorAward.trim();
  const ipCount = Number(qna.ipCount);
  if (qna.ipCount.trim() && Number.isFinite(ipCount)) legacy.ip = `${ipCount.toLocaleString("ko-KR")}건`;

  const selfDeclared = (row: FieldCoverageRow, value: string, extra?: Partial<MergedCoverageRow>): MergedCoverageRow => ({
    ...row,
    status: "self-declared",
    value,
    confidence: 0.6,
    source: null,
    sourceKind: "self_declared",
    asOf: new Date().toISOString(),
    axisCompleteness: row.parentKey ? "partial" : "complete",
    ...extra,
  });

  const financialAnswered = qna.capitalImpairment !== "" || isNumeric(qna.equityEok);
  const investmentAnswered = qna.tipsBacked || isNumeric(qna.investmentEok) || qna.investmentRound.trim().length > 0;

  return coverage.map((row): MergedCoverageRow => {
    // 예비창업 자가신고는 파생-라이브 target_type도 덮는다(사용자 의도 우선).
    if (row.key === "target_type" && qna.isPreliminary) {
      return selfDeclared(row, "예비창업자");
    }
    // 라이브/캐시/해당없음은 원천 유지(회귀 금지).
    if (row.status === "live" || row.status === "cache" || row.status === "n/a") return row;

    // 결격 3축 부모 행.
    if (row.dimension && (DISQ_AXES as readonly string[]).includes(row.dimension) && !row.parentKey) {
      const axis = byAxis.get(row.dimension);
      if (axis?.answered) {
        const presentLabels = axis.presentFlags.map((flag) => flagLabel.get(flag) ?? flag);
        const knownLabels = axis.knownFlags.map((flag) => flagLabel.get(flag) ?? flag);
        return selfDeclared(
          row,
          presentLabels.length > 0 ? `결격 보유: ${presentLabels.join(", ")}` : "결격 없음(자가확인)",
          {
            knownFlagLabels: knownLabels,
            presentFlagLabels: presentLabels,
            exceptionLabels: exceptionLabelsForAxis(row.dimension),
            axisCompleteness: axis.complete ? "complete" : "partial",
          },
        );
      }
      return row;
    }

    // 결격 하위 플래그 행.
    if (row.flag && row.parentKey) {
      const axis = byAxis.get(row.parentKey);
      if (axis?.answered && axis.knownFlags.includes(row.flag)) {
        const present = axis.presentFlags.includes(row.flag);
        return selfDeclared(row, present ? "보유(있음)" : "없음(자가확인)");
      }
      return row;
    }

    // 재무건전성.
    if (row.subField === "impairment" && qna.capitalImpairment) {
      return selfDeclared(row, impairmentLabel(qna.capitalImpairment));
    }
    if (row.subField === "equity_krw" && isNumeric(qna.equityEok)) {
      return selfDeclared(row, `${Number(qna.equityEok).toLocaleString("ko-KR")}억원`);
    }
    if (row.dimension === "financial_health" && !row.parentKey && financialAnswered) {
      const parts: string[] = [];
      if (qna.capitalImpairment) parts.push(`자본잠식 ${impairmentLabel(qna.capitalImpairment)}`);
      if (isNumeric(qna.equityEok)) parts.push(`자본총계 ${Number(qna.equityEok).toLocaleString("ko-KR")}억원`);
      return selfDeclared(row, parts.join(" · "), { axisCompleteness: "partial" });
    }

    // 고용 — evaluator 판정 매트릭스(no_layoff=false + 시점 null → unknown)를 표시값에 반영.
    if (row.subField === "no_layoff" && qna.noLayoff) {
      return selfDeclared(row, layoffLabel(qna));
    }
    if (row.dimension === "insured_workforce" && !row.parentKey && qna.noLayoff) {
      return selfDeclared(row, `${layoffLabel(qna)}(자가신고)`);
    }

    // 투자.
    if (row.subField === "tips_backed" && qna.tipsBacked) return selfDeclared(row, "TIPS 선정");
    if (row.subField === "total_raised_krw" && isNumeric(qna.investmentEok)) {
      return selfDeclared(row, `${Number(qna.investmentEok).toLocaleString("ko-KR")}억원`);
    }
    if (row.subField === "last_round" && qna.investmentRound.trim()) {
      return selfDeclared(row, qna.investmentRound.trim());
    }
    if (row.dimension === "investment" && !row.parentKey && investmentAnswered) {
      const parts: string[] = [];
      if (qna.tipsBacked) parts.push("TIPS 선정");
      if (isNumeric(qna.investmentEok)) parts.push(`${Number(qna.investmentEok).toLocaleString("ko-KR")}억원`);
      if (qna.investmentRound.trim()) parts.push(qna.investmentRound.trim());
      return selfDeclared(row, parts.join(" · "), { axisCompleteness: "partial" });
    }

    // 레거시 축(매출·근로자·연령·특성·인증·수혜·IP).
    const override = legacy[row.key];
    if (override !== undefined) {
      const partialListAnswer =
        row.key === "founder_trait" || row.key === "certification" || row.key === "prior_award";
      return selfDeclared(row, override, partialListAnswer ? { axisCompleteness: "partial" } : undefined);
    }

    return row;
  });
}

/** 감원 자가신고 표시값 — 감원 있음 + 경과 개월이 있어야 매칭 판정 가능(없으면 unknown 명시). */
function layoffLabel(qna: QnaState): string {
  if (qna.noLayoff === "yes") return "감원 없음";
  if (isNumeric(qna.layoffMonths)) {
    return `감원 있음 · ${Number(qna.layoffMonths).toLocaleString("ko-KR")}개월 경과`;
  }
  return "감원 있음 · 시점 미상(매칭 unknown)";
}

function impairmentLabel(value: QnaState["capitalImpairment"]): string {
  if (value === "none") return "없음";
  if (value === "partial") return "부분잠식";
  if (value === "full") return "완전잠식";
  return "";
}

function isNumeric(raw: string): boolean {
  return raw.trim().length > 0 && Number.isFinite(Number(raw));
}

function computeAge(birthYearRaw: string): number | null {
  const year = Number(birthYearRaw);
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) return null;
  return new Date().getFullYear() - year;
}

function providerLabel(provider: string): string {
  if (provider === "popbill") return "팝빌";
  if (provider === "apick") return "Apick";
  if (provider === "nts") return "국세청";
  if (provider === "smpp") return "공공구매종합정보망";
  return provider;
}

function errorTitle(code: string): string {
  if (code === "biz_no_closed") return "폐업한 사업자";
  if (code === "biz_no_not_registered") return "미등록 사업자";
  if (code === "popbill_cache_unavailable") return "캐시 저장소 사용 불가";
  if (code === "apick_cache_unavailable") return "Apick 캐시 저장소 사용 불가";
  if (code === "apick_live_lookup_limited") return "Apick 조회 한도 보호";
  if (code === "apick_lookup_timeout") return "Apick 응답 시간 초과";
  return "조회 오류";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function maskLocal(bizNo: string): string {
  if (bizNo.length !== 10) return bizNo;
  return `${bizNo.slice(0, 3)}-**-*${bizNo.slice(6)}`;
}
