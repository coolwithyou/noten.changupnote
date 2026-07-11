"use client";

import { memo, useCallback, useMemo, useState } from "react";
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

  const runLookup = useCallback(async (bizNo: string, forceRefresh: boolean, selectedProvider: ServiceDataProvider) => {
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
  }, []);

  const onSearch = useCallback(async () => {
    const digits = bizNoInput.replace(/\D/g, "");
    if (digits.length !== 10) {
      toast.error("사업자번호 10자리를 입력해주세요.");
      return;
    }
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
  const stats = useMemo(() => summarizeCoverage(mergedCoverage), [mergedCoverage]);

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
          {/* 2. 22축 커버리지 대시보드 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">22축 커버리지</CardTitle>
              <CardDescription className="flex flex-col gap-1">
                <span>
                  {result.maskedBizNo} · {subjectLabel(result.subject)} · 매칭 차원별 계획 소스와 확보 상태.
                  자가신고(Q&A) 값은 아래에서 입력하면 즉시 병합됩니다.
                </span>
                <span className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Badge className="bg-primary text-primary-foreground">라이브/캐시 {stats.live}</Badge>
                  <Badge variant="outline" className="border-success/50 text-success">자가신고 {stats.selfDeclared}</Badge>
                  <Badge variant="outline">대기 {stats.pending}</Badge>
                  <Badge variant="destructive">실패 {stats.failed}</Badge>
                  <Badge variant="secondary">해당없음 {stats.na}</Badge>
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[9rem]">필드</TableHead>
                      <TableHead className="w-[5%]">층</TableHead>
                      <TableHead className="w-[24%]">계획 소스</TableHead>
                      <TableHead className="w-[13%]">상태</TableHead>
                      <TableHead>값</TableHead>
                      <TableHead className="w-[9%]">신뢰도</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mergedCoverage.map((row) => (
                      <TableRow key={row.key} className={row.parentKey ? "border-0" : "border-t-2 border-border"}>
                        <TableCell className={row.parentKey ? "py-1.5 pl-6 text-xs text-muted-foreground" : "font-medium"}>
                          {row.parentKey ? `└ ${row.label}` : row.label}
                        </TableCell>
                        <TableCell className={row.parentKey ? "py-1.5" : ""}>
                          <TierBadge tier={row.tier} />
                        </TableCell>
                        <TableCell className={`text-xs text-muted-foreground ${row.parentKey ? "py-1.5" : ""}`}>
                          {row.plannedSource}
                        </TableCell>
                        <TableCell className={row.parentKey ? "py-1.5" : ""}>
                          <StatusBadge status={row.status} source={row.source} note={row.note} />
                        </TableCell>
                        <TableCell className={row.parentKey ? "py-1.5" : ""}>
                          <ValueCell row={row} />
                        </TableCell>
                        <TableCell className={row.parentKey ? "py-1.5" : ""}>
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
            </CardContent>
          </Card>

          {/* 3. API 트레이스 */}
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

// ── 커버리지 셀 렌더 ──────────────────────────────────────────────────────────

function ValueCell({ row }: { row: MergedCoverageRow }) {
  const hasKnown = (row.knownFlagLabels?.length ?? 0) > 0;
  return (
    <div className="flex flex-col gap-1">
      {row.value ? (
        <span className="text-sm">{row.value}</span>
      ) : (
        <span className="text-xs text-muted-foreground">{row.status === "n/a" ? "대상 아님" : row.note ?? "미확보"}</span>
      )}
      {hasKnown ? <KnownFlags known={row.knownFlagLabels ?? []} present={row.presentFlagLabels ?? []} exceptions={row.exceptionLabels ?? []} /> : null}
    </div>
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

function StatusBadge({ status, source, note }: { status: FieldCoverageStatus; source: FieldSourceRef | null; note: string | null }) {
  if (status === "live") {
    return <Badge className="bg-primary text-primary-foreground">라이브 · {sourceRefLabel(source)}</Badge>;
  }
  if (status === "cache") {
    return <Badge variant="secondary">캐시 · {sourceRefLabel(source)}</Badge>;
  }
  if (status === "self-declared") {
    return <Badge variant="outline" className="border-success/50 text-success">자가신고</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive">실패{note ? ` · ${note}` : ""}</Badge>;
  }
  if (status === "n/a") {
    return <Badge variant="secondary" className="text-muted-foreground">해당 없음</Badge>;
  }
  // pending
  return (
    <Badge variant="outline" className="border-dashed text-muted-foreground">
      대기{note ? ` · ${note}` : ""}
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
  if (source === "derived") return "추론";
  return "—";
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

interface CoverageStats {
  live: number;
  selfDeclared: number;
  pending: number;
  failed: number;
  na: number;
}

function summarizeCoverage(rows: MergedCoverageRow[]): CoverageStats {
  const stats: CoverageStats = { live: 0, selfDeclared: 0, pending: 0, failed: 0, na: 0 };
  for (const row of rows) {
    if (row.status === "live" || row.status === "cache") stats.live += 1;
    else if (row.status === "self-declared") stats.selfDeclared += 1;
    else if (row.status === "failed") stats.failed += 1;
    else if (row.status === "n/a") stats.na += 1;
    else stats.pending += 1;
  }
  return stats;
}

interface AxisQna {
  answered: boolean;
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
    let answered = false;
    for (const group of axis.questions) {
      for (const flag of group.flags) flagLabel.set(flag.flag, flag.label);
      const groupFlags = qna.disqFlags[group.id] ?? [];
      const groupAnswered = Boolean(qna.disqConfirmed[group.id]) || groupFlags.length > 0;
      if (groupAnswered) {
        answered = true;
        for (const flag of group.flags) known.push(flag.flag);
        for (const flag of groupFlags) present.push(flag);
      }
    }
    byAxis.set(axis.axis, { answered, knownFlags: known, presentFlags: present });
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
  const exceptionLabel = new Map(schema.exceptions.map((exception) => [exception.key, exception.label]));
  const exceptionLabels = qna.disqExceptions.map((key) => exceptionLabel.get(key) ?? key);

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
          { knownFlagLabels: knownLabels, presentFlagLabels: presentLabels, exceptionLabels },
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
      return selfDeclared(row, parts.join(" · "));
    }

    // 고용.
    if (row.subField === "no_layoff" && qna.noLayoff) {
      return selfDeclared(row, qna.noLayoff === "yes" ? "감원 없음" : "감원 있음");
    }
    if (row.dimension === "insured_workforce" && !row.parentKey && qna.noLayoff) {
      return selfDeclared(row, qna.noLayoff === "yes" ? "감원 없음(자가신고)" : "감원 있음(자가신고)");
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
      return selfDeclared(row, parts.join(" · "));
    }

    // 레거시 축(매출·근로자·연령·특성·인증·수혜·IP).
    const override = legacy[row.key];
    if (override !== undefined) return selfDeclared(row, override);

    return row;
  });
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
