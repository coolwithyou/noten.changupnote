"use client";

import type {
  ActionResult,
  CreditBalanceDto,
  CreditLedgerListDto,
  CreditOrderListDto,
  CreditUsageEventDto,
  CreditUsageListDto,
} from "@cunote/contracts";
import {
  ArrowUpRight,
  ChevronDown,
  Coins,
  Download,
  ExternalLink,
  Hourglass,
  Timer,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// 사용 내역 필터에 노출할 기능 사전(3.2 — 사용자 트리거 과금 기능만).
const FEATURE_FILTER_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "", label: "전체 기능" },
  { code: "application_draft", label: "지원서 초안 생성" },
  { code: "application_review", label: "지원서 첨삭" },
  { code: "business_plan_section", label: "사업계획서 섹션 작성" },
  { code: "writing_guide_chat", label: "작성 가이드 대화" },
  { code: "expert_field_answer", label: "전문가 필드 답변" },
];

type TabKey = "usage" | "ledger" | "payments";

export function UsagePageView() {
  const [tab, setTab] = useState<TabKey>("usage");
  const [balance, setBalance] = useState<CreditBalanceDto | null>(null);
  const [usage, setUsage] = useState<CreditUsageListDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/web/credits/balance");
        const result = (await res.json()) as ActionResult<CreditBalanceDto>;
        if (!cancelled && result.ok && result.data) setBalance(result.data);
      } catch {
        // 요약은 보조 — 실패해도 탭은 동작.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SummaryHeader balance={balance} usage={usage} />

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <TabsList>
          <TabsTrigger value="usage">사용 내역</TabsTrigger>
          <TabsTrigger value="ledger">크레딧 원장</TabsTrigger>
          <TabsTrigger value="payments">결제 내역</TabsTrigger>
        </TabsList>

        <TabsContent value="usage" className="pt-4">
          <UsageTab onSummary={setUsage} />
        </TabsContent>
        <TabsContent value="ledger" className="pt-4">
          <LedgerTab />
        </TabsContent>
        <TabsContent value="payments" className="pt-4">
          <PaymentsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── 상단 요약(설계 10.3) ──────────────────────────────────────────────────────
function SummaryHeader({
  balance,
  usage,
}: {
  balance: CreditBalanceDto | null;
  usage: CreditUsageListDto | null;
}) {
  const available = balance?.available ?? null;
  const pending = balance?.pendingHolds ?? null;
  const monthUsed = usage?.summary.totalCredits ?? null;

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="크레딧 요약">
      <SummaryCard
        icon={<Wallet />}
        label="사용 가능 잔액"
        value={available === null ? "…" : `${available.toLocaleString("ko-KR")} 크레딧`}
        hint={balance?.lowBalance ? "잔액이 부족합니다" : "예약(hold) 반영 기준"}
        tone={balance?.lowBalance ? "amber" : "neutral"}
      />
      <SummaryCard
        icon={<Coins />}
        label="이번 조회 기간 사용"
        value={monthUsed === null ? "…" : `${monthUsed.toLocaleString("ko-KR")} 크레딧`}
        hint="사용 내역 필터 기준 합계"
        tone="neutral"
      />
      <SummaryCard
        icon={<Hourglass />}
        label="진행 중 예약(hold)"
        value={pending === null ? "…" : `${pending.toLocaleString("ko-KR")} 크레딧`}
        hint="진행 중인 AI 작업 선점분"
        tone="neutral"
      />
      <ExpiringCard expiring={balance?.expiringSoon ?? []} />
    </section>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone: "neutral" | "amber";
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-[var(--radius-md)]",
              tone === "amber" ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground",
              "[&>svg]:size-4",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <span className="text-xs font-medium">{label}</span>
        </div>
        <strong className={cn("text-lg font-semibold", tone === "amber" ? "text-amber-600" : "text-foreground")}>
          {value}
        </strong>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </CardContent>
    </Card>
  );
}

function ExpiringCard({
  expiring,
}: {
  expiring: CreditBalanceDto["expiringSoon"];
}) {
  const total = expiring.reduce((sum, l) => sum + l.remaining, 0);
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex size-8 items-center justify-center rounded-[var(--radius-md)] bg-muted text-muted-foreground [&>svg]:size-4" aria-hidden="true">
            <Timer />
          </span>
          <span className="text-xs font-medium">만료 예정(14일 내)</span>
        </div>
        <strong className={cn("text-lg font-semibold", total > 0 ? "text-amber-600" : "text-foreground")}>
          {total.toLocaleString("ko-KR")} 크레딧
        </strong>
        {expiring.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {expiring.slice(0, 2).map((l) => (
              <li key={l.lotId}>
                {l.remaining.toLocaleString("ko-KR")} 크레딧 · {formatDate(l.expiresAt)} 만료
              </li>
            ))}
            {expiring.length > 2 ? <li>외 {expiring.length - 2}건</li> : null}
          </ul>
        ) : (
          <span className="text-xs text-muted-foreground">임박한 만료 없음</span>
        )}
      </CardContent>
    </Card>
  );
}

// ── 탭 1: 사용 내역(설계 10.3) ────────────────────────────────────────────────
// 기본 표시: 기능명(한국어) · 차감 크레딧 · 원화 환산. 토큰/모델은 "상세" 토글 안에만.
function UsageTab({ onSummary }: { onSummary: (u: CreditUsageListDto) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [feature, setFeature] = useState("");
  const [data, setData] = useState<CreditUsageListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      if (feature) query.set("feature", feature);
      query.set("limit", "50");
      const res = await fetch(`/api/web/credits/usage?${query.toString()}`);
      const result = (await res.json()) as ActionResult<CreditUsageListDto>;
      if (result.ok && result.data) {
        setData(result.data);
        onSummary(result.data);
      } else {
        setError(result.error?.message ?? "사용 내역을 불러오지 못했습니다.");
      }
    } catch {
      setError("사용 내역을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [from, to, feature, onSummary]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportHref = useMemo(() => {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    const qs = query.toString();
    return `/api/web/credits/usage/export${qs ? `?${qs}` : ""}`;
  }, [from, to]);

  return (
    <div className="flex flex-col gap-4">
      {/* 필터 바 + CSV */}
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor="usage-filter-from">시작일</FieldLabel>
          <Input
            id="usage-filter-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-auto"
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="usage-filter-to">종료일</FieldLabel>
          <Input
            id="usage-filter-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-auto"
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="usage-filter-feature">기능</FieldLabel>
          <Select value={feature} onValueChange={(value) => setFeature(value ?? "")}>
            <SelectTrigger id="usage-filter-feature" className="h-9 w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {FEATURE_FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.code} value={o.code}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <a
          href={exportHref}
          className={buttonVariants({ variant: "outline", size: "sm", className: "ml-auto" })}
        >
          <Download data-icon="inline-start" />
          CSV 내보내기
        </a>
      </div>

      {/* 일 단위 소모 막대(외부 라이브러리 없이 CSS) */}
      <DailyUsageChart events={data?.events ?? []} />

      {/* 사용 내역 목록 */}
      {loading ? (
        <CenteredSpinner />
      ) : error ? (
        <EmptyState text={error} />
      ) : !data || data.events.length === 0 ? (
        <EmptyState text="선택한 기간에 사용 내역이 없습니다." />
      ) : (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border p-0">
            {data.events.map((e) => (
              <UsageRow key={e.id} event={e} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const USAGE_STATUS_LABEL: Record<CreditUsageEventDto["status"], { label: string; tone: "outline" | "secondary" | "destructive" | "ghost" }> = {
  settled: { label: "정산 완료", tone: "outline" },
  pending: { label: "정산 대기", tone: "secondary" },
  failed: { label: "실패", tone: "destructive" },
  free: { label: "무료", tone: "ghost" },
};

function UsageRow({ event }: { event: CreditUsageEventDto }) {
  const [open, setOpen] = useState(false);
  const status = USAGE_STATUS_LABEL[event.status];
  const docLink = documentLinkFor(event.contextRef);
  const hasDetail = event.model !== null || event.inputTokens > 0 || event.outputTokens > 0;

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{event.featureLabel}</span>
            <Badge variant={status.tone}>{status.label}</Badge>
          </div>
          <span className="text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</span>
          {docLink ? (
            <a
              href={docLink.href}
              className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {docLink.label}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="text-sm font-semibold text-foreground">
            {event.creditsCharged > 0 ? `${event.creditsCharged.toLocaleString("ko-KR")} 크레딧` : "0 크레딧"}
          </span>
          {event.creditsCharged > 0 ? (
            <span className="text-xs text-muted-foreground">약 {event.creditsCharged.toLocaleString("ko-KR")}원 상당</span>
          ) : (
            <span className="text-xs text-muted-foreground">무과금</span>
          )}
        </div>
      </div>

      {/* 상세 토글 — 토큰/모델은 여기에만 노출(기본 테이블 금지 규약) */}
      {hasDetail ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            className="h-auto w-fit gap-1 px-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
            aria-expanded={open}
          >
            상세 {open ? "숨기기" : "보기"}
            <ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-180" : "")} aria-hidden="true" />
          </Button>
          {open ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 rounded-[var(--radius-md)] bg-muted/40 p-3 text-xs sm:grid-cols-4">
              <DetailCell label="모델" value={event.model ?? "-"} />
              <DetailCell label="입력 토큰" value={event.inputTokens.toLocaleString("ko-KR")} />
              <DetailCell label="출력 토큰" value={event.outputTokens.toLocaleString("ko-KR")} />
              <DetailCell label="차감 크레딧" value={event.creditsCharged.toLocaleString("ko-KR")} />
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

// 일 단위 크레딧 소모 막대(CSS만). 조회된 이벤트를 날짜별로 합산.
function DailyUsageChart({ events }: { events: CreditUsageEventDto[] }) {
  const days = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const e of events) {
      if (e.creditsCharged <= 0) continue;
      const day = e.createdAt.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + e.creditsCharged);
    }
    return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [events]);

  if (days.length === 0) return null;
  const max = Math.max(...days.map(([, v]) => v), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">일 단위 크레딧 소모</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex items-end gap-2 overflow-x-auto pb-1" style={{ minHeight: "6rem" }}>
          {days.map(([day, value]) => {
            // 콤마 포함 Tailwind arbitrary 금지 규약 → 높이는 인라인 스타일(CSS 변수 성격)로.
            const heightPct = Math.max(6, Math.round((value / max) * 100));
            return (
              <li key={day} className="flex min-w-8 flex-1 flex-col items-center gap-1" title={`${day} · ${value.toLocaleString("ko-KR")} 크레딧`}>
                <div className="flex h-20 w-full items-end">
                  <div
                    className="w-full rounded-t-[var(--radius-sm)] bg-primary/70"
                    style={{ height: `${heightPct}%` }}
                    aria-hidden="true"
                  />
                </div>
                <span className="text-[0.625rem] text-muted-foreground">{day.slice(5)}</span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ── 탭 2: 크레딧 원장(설계 10.3) ──────────────────────────────────────────────
const LEDGER_BADGE: Record<string, { label: string; tone: "outline" | "secondary" | "destructive" | "ghost" | "default" }> = {
  signup_bonus_grant: { label: "지급", tone: "default" },
  purchase_grant: { label: "지급", tone: "default" },
  plan_grant: { label: "지급", tone: "default" },
  admin_grant: { label: "지급", tone: "default" },
  promo_grant: { label: "지급", tone: "default" },
  usage_capture: { label: "차감", tone: "secondary" },
  admin_deduct: { label: "차감", tone: "secondary" },
  refund_deduct: { label: "환불", tone: "destructive" },
  expiry: { label: "만료", tone: "ghost" },
  reversal: { label: "정정", tone: "outline" },
};

function LedgerTab() {
  const [entries, setEntries] = useState<CreditLedgerListDto["entries"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextCursor: string | null) => {
    if (nextCursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (nextCursor) query.set("cursor", nextCursor);
      const res = await fetch(`/api/web/credits/ledger?${query.toString()}`);
      const result = (await res.json()) as ActionResult<CreditLedgerListDto>;
      if (result.ok && result.data) {
        setEntries((prev) => (nextCursor ? [...prev, ...result.data!.entries] : result.data!.entries));
        setCursor(result.data.cursor);
        setHasMore(result.data.hasMore);
      } else {
        setError(result.error?.message ?? "크레딧 원장을 불러오지 못했습니다.");
      }
    } catch {
      setError("크레딧 원장을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  if (loading) return <CenteredSpinner />;
  if (error) return <EmptyState text={error} />;
  if (entries.length === 0) return <EmptyState text="아직 크레딧 원장 기록이 없습니다." />;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col divide-y divide-border p-0">
          {entries.map((e) => {
            const badge = LEDGER_BADGE[e.entryType] ?? { label: "기록", tone: "outline" as const };
            const isUsage = e.entryType === "usage_capture";
            return (
              <div key={e.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={badge.tone}>{badge.label}</Badge>
                    <span className="truncate text-sm font-medium text-foreground">{e.description}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                  {isUsage ? (
                    <a href="#usage" className="text-xs font-medium text-primary hover:underline">
                      이 차감은 어디서? — 사용 내역 보기
                    </a>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <span
                    className={cn(
                      "text-sm font-semibold",
                      e.amount >= 0 ? "text-emerald-600" : "text-foreground",
                    )}
                  >
                    {e.amount >= 0 ? "+" : ""}
                    {e.amount.toLocaleString("ko-KR")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    잔액 {e.balanceAfter.toLocaleString("ko-KR")}
                  </span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load(cursor)}
          disabled={loadingMore}
          className="self-center"
        >
          {loadingMore ? "불러오는 중…" : "더 보기"}
        </Button>
      ) : null}
    </div>
  );
}

// ── 탭 3: 결제 내역(설계 10.3) ────────────────────────────────────────────────
const ORDER_STATUS_LABEL: Record<string, { label: string; tone: "outline" | "secondary" | "destructive" | "default" | "ghost" }> = {
  created: { label: "결제 대기", tone: "secondary" },
  pending: { label: "결제 대기", tone: "secondary" },
  paid: { label: "충전 완료", tone: "default" },
  failed: { label: "실패", tone: "destructive" },
  expired: { label: "만료", tone: "ghost" },
  refunded: { label: "환불", tone: "destructive" },
  partial_refunded: { label: "부분 환불", tone: "destructive" },
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  credit_topup: "크레딧 충전",
  plan_initial: "플랜 구독 시작",
  plan_renewal: "플랜 갱신",
};

function PaymentsTab() {
  const [orders, setOrders] = useState<CreditOrderListDto["orders"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextCursor: string | null) => {
    if (nextCursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (nextCursor) query.set("cursor", nextCursor);
      const res = await fetch(`/api/web/credits/orders?${query.toString()}`);
      const result = (await res.json()) as ActionResult<CreditOrderListDto>;
      if (result.ok && result.data) {
        setOrders((prev) => (nextCursor ? [...prev, ...result.data!.orders] : result.data!.orders));
        setCursor(result.data.cursor);
        setHasMore(result.data.hasMore);
      } else {
        setError(result.error?.message ?? "주문 내역을 불러오지 못했습니다.");
      }
    } catch {
      setError("주문 내역을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  if (loading) return <CenteredSpinner />;
  if (error) return <EmptyState text={error} />;
  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <EmptyState text="결제 내역이 없습니다." />
        <a href="/credits" className={buttonVariants({ size: "sm" })}>
          크레딧 충전하러 가기
          <ArrowUpRight data-icon="inline-end" />
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col divide-y divide-border p-0">
          {orders.map((o) => {
            const status = ORDER_STATUS_LABEL[o.status] ?? { label: o.status, tone: "outline" as const };
            return (
              <div key={o.paymentId} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {o.amountKrw.toLocaleString("ko-KR")}원
                    </span>
                    <Badge variant={status.tone}>{status.label}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {ORDER_TYPE_LABEL[o.orderType] ?? o.orderType} · {o.creditsToGrant.toLocaleString("ko-KR")} 크레딧
                    {o.payMethod ? ` · ${o.payMethod}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(o.paidAt ?? o.createdAt)}
                    {o.refundedAmountKrw > 0
                      ? ` · 환불 ${o.refundedAmountKrw.toLocaleString("ko-KR")}원`
                      : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load(cursor)}
          disabled={loadingMore}
          className="self-center"
        >
          {loadingMore ? "불러오는 중…" : "더 보기"}
        </Button>
      ) : null}
    </div>
  );
}

// ── 공용 ─────────────────────────────────────────────────────────────────────
function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <Spinner className="size-6" />
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>;
}

/** contextRef 에 문서 참조가 있으면 해당 문서 링크를 만든다(설계 10.3). PII 없음(12.4). */
function documentLinkFor(contextRef: Record<string, unknown>): { href: string; label: string } | null {
  const grantId = typeof contextRef.grantId === "string" ? contextRef.grantId : null;
  if (grantId) return { href: `/grants/${grantId}`, label: "관련 지원사업 보기" };
  const draftId = typeof contextRef.draftId === "string" ? contextRef.draftId : null;
  if (draftId) return { href: "/applications", label: "관련 신청서 보기" };
  return null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
