"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  ServiceDataField,
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
// 개발 전용 사업자 데이터 모니터. 조회 파이프라인(팝빌·국세청·공공구매종합정보망)의
// 캐시/라이브 원천을 투명하게 확인하고, API로 확보 불가한 축은 Q&A(자가신고)로 병합해 본다.
// Q&A 입력은 서버에 저장하지 않는 클라이언트 로컬 상태 — 매칭 축 채움을 눈으로 확인하는 용도.
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

type FieldSourceLabel = "popbill" | "apick" | "nts" | "smpp" | "qna";

interface MergedField {
  key: string;
  label: string;
  value: string | null;
  source: FieldSourceLabel | null;
  confidence: number | null;
  available: boolean;
}

interface QnaState {
  birthYear: string;
  traits: string[];
  employees: string;
  revenueEok: string;
  certs: string[];
  priorAward: string;
  ipCount: string;
  isPreliminary: boolean;
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
};

export function ServiceDataMonitor() {
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

  const mergedFields = useMemo(
    () => mergeFieldsWithQna(result?.fields ?? [], qna),
    [result?.fields, qna],
  );
  const traceOriginBySource = useMemo(() => buildOriginMap(result?.trace ?? []), [result?.trace]);

  const busy = inspecting || loading;
  const showCacheChoice = Boolean(inspect?.hasCache && activeBizNo);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">사업자 데이터 모니터</h1>
          <Badge variant="outline">dev</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          사업자번호로 조회 파이프라인(팝빌 · 국세청 · 공공구매종합정보망)을 실행하고, 매칭 축별 원천과
          캐시/라이브 여부, 원본 응답을 확인합니다.
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
          {/* 2. 매칭 필드 테이블 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">매칭 필드</CardTitle>
              <CardDescription>
                {result.maskedBizNo} · 원천별 확보 현황. 자가신고(Q&A) 값은 아래에서 입력하면 즉시
                병합됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[26%]">필드</TableHead>
                    <TableHead>값</TableHead>
                    <TableHead className="w-[22%]">원천</TableHead>
                    <TableHead className="w-[14%]">신뢰도</TableHead>
                    <TableHead className="w-[16%]">캐시/라이브</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mergedFields.map((field) => (
                    <TableRow key={field.key}>
                      <TableCell className="font-medium">{field.label}</TableCell>
                      <TableCell>
                        {field.available && field.value ? (
                          field.value
                        ) : (
                          <span className="text-muted-foreground">미확보</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <SourceBadge source={field.source} />
                      </TableCell>
                      <TableCell>
                        {typeof field.confidence === "number" ? (
                          `${Math.round(field.confidence * 100)}%`
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <OriginBadge
                          origin={
                            field.source && field.source !== "qna"
                              ? traceOriginBySource.get(field.source) ?? null
                              : null
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
      <QnaSection qna={qna} setQna={setQna} disabled={!result} />

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

function QnaSection({
  qna,
  setQna,
  disabled,
}: {
  qna: QnaState;
  setQna: React.Dispatch<React.SetStateAction<QnaState>>;
  disabled: boolean;
}) {
  const toggleInArray = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">자가신고 (Q&A)</CardTitle>
        <CardDescription>
          API로 확보할 수 없어 사용자에게 받아야 하는 축입니다. 입력하면 위 매칭 필드 테이블에 바로
          병합됩니다(서버 저장 없음, 모니터 확인용).
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
              onCheckedChange={(checked) => setQna((prev) => ({ ...prev, isPreliminary: checked }))}
            />
            예비창업자입니다
          </Label>
        </QnaField>
      </CardContent>
    </Card>
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

function SourceBadge({ source }: { source: FieldSourceLabel | null }) {
  if (!source) return <span className="text-muted-foreground">—</span>;
  if (source === "popbill") return <Badge variant="secondary">팝빌</Badge>;
  if (source === "apick") return <Badge>Apick</Badge>;
  if (source === "nts") return <Badge>국세청</Badge>;
  if (source === "smpp") {
    return (
      <Badge variant="outline" className="border-primary/40 text-primary">
        공공구매망
      </Badge>
    );
  }
  return <Badge variant="outline">자가신고 (Q&A)</Badge>;
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

function buildOriginMap(trace: ServiceDataTraceEntry[]): Map<string, "live" | "cache"> {
  const map = new Map<string, "live" | "cache">();
  for (const entry of trace) {
    if (!map.has(entry.provider)) map.set(entry.provider, entry.origin);
  }
  return map;
}

/** 서버 필드(10축)에 Q&A 입력을 override/append 로 병합한다. Q&A 값은 source="qna". */
function mergeFieldsWithQna(serverFields: ServiceDataField[], qna: QnaState): MergedField[] {
  const overrides = new Map<string, string>();
  const age = computeAge(qna.birthYear);
  if (age !== null) overrides.set("founder_age", `만 ${age}세`);
  const employees = Number(qna.employees);
  if (qna.employees.trim() && Number.isFinite(employees)) {
    overrides.set("employees", `${employees.toLocaleString("ko-KR")}명`);
  }
  const revenueEok = Number(qna.revenueEok);
  if (qna.revenueEok.trim() && Number.isFinite(revenueEok)) {
    overrides.set("revenue", `${revenueEok.toLocaleString("ko-KR")}억원`);
  }
  if (qna.certs.length > 0) overrides.set("certification", qna.certs.join(", "));

  const base: MergedField[] = serverFields.map((field) => {
    const override = overrides.get(field.key);
    if (override !== undefined) {
      return { ...field, value: override, available: true, source: "qna", confidence: null };
    }
    return { ...field, source: field.source as FieldSourceLabel | null };
  });

  const extras: MergedField[] = [];
  const pushExtra = (key: string, label: string, value: string) =>
    extras.push({ key, label, value, available: true, source: "qna", confidence: null });

  if (qna.traits.length > 0) pushExtra("founder_trait", "대표자 특성", qna.traits.join(", "));
  if (qna.priorAward.trim()) pushExtra("prior_award", "정책자금·수혜 이력", qna.priorAward.trim());
  const ipCount = Number(qna.ipCount);
  if (qna.ipCount.trim() && Number.isFinite(ipCount)) {
    pushExtra("ip", "특허·지재권", `${ipCount.toLocaleString("ko-KR")}건`);
  }
  if (qna.isPreliminary) pushExtra("target_type", "예비창업자 여부", "예비창업자");

  return [...base, ...extras];
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
