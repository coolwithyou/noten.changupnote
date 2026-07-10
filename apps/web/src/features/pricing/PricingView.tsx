"use client";

import type {
  ActionResult,
  CreditPlanChangeResultDto,
  CreditPlanDto,
  CreditPlansDto,
  CreditProductDto,
  CreditSubscribeResultDto,
  CreditSubscriptionDto,
} from "@cunote/contracts";
import { AlertTriangle, Check, CheckCircle2, Info, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/app/status-badge";
import { requestIssueBillingKey } from "@/features/credits/portoneBrowser";

// NEXT_PUBLIC_* 는 클라이언트 번들에 빌드타임 인라인된다(직접 참조). 설계 7.1/8.2.
// 미설정 환경에서는 결제 준비 중으로 graceful disable 한다.
const PORTONE_STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID?.trim() ?? "";
const PORTONE_BILLING_CHANNEL_KEY = process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSS_BILLING?.trim() ?? "";
const PAYMENT_READY = PORTONE_STORE_ID.length > 0 && PORTONE_BILLING_CHANNEL_KEY.length > 0;

// 플랜별 기본 기능 불릿(API features 없을 때 폴백). 설계 10.1.
const DEFAULT_FEATURE_BULLETS: Record<string, string[]> = {
  plus: ["월간 크레딧 자동 충전", "충전 대비 높은 보너스율", "지원서 초안·첨삭·가이드"],
  pro: ["Plus의 모든 기능", "더 많은 월간 크레딧", "우선 지원"],
  flex: ["헤비유저·대행사용", "최대 월간 크레딧", "플랜 크레딧 90일 이월 우대"],
};

type Feedback =
  | { kind: "subscribed"; grantedCredits: number; periodEnd: string; planName: string }
  | { kind: "upgraded"; grantedCredits: number; planName: string }
  | { kind: "downgrade_scheduled"; planName: string }
  | { kind: "error"; message: string };

export function PricingView({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [plans, setPlans] = useState<CreditPlanDto[]>([]);
  const [subscription, setSubscription] = useState<CreditSubscriptionDto | null>(null);
  const [products, setProducts] = useState<CreditProductDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [expiryConsent, setExpiryConsent] = useState(false);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // 소멸 동의 미체크 상태에서 구독을 시도했는지(인라인 안내 노출용).
  const [consentBlocked, setConsentBlocked] = useState(false);

  const load = useMemo(
    () =>
      async function load(signal?: { cancelled: boolean }) {
        setLoading(true);
        try {
          const res = await fetch("/api/web/plans").then(
            (r) => r.json() as Promise<ActionResult<CreditPlansDto>>,
          );
          if (signal?.cancelled) return;
          if (res.ok && res.data) {
            setPlans(res.data.plans);
            setSubscription(res.data.subscription);
            setProducts(res.data.products ?? []);
            setLoadError(null);
          } else {
            setLoadError(res.error?.message ?? "플랜 정보를 불러오지 못했습니다.");
          }
        } catch {
          if (!signal?.cancelled) setLoadError("플랜 정보를 불러오지 못했습니다.");
        } finally {
          if (!signal?.cancelled) setLoading(false);
        }
      },
    [],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  async function handleSubscribe(plan: CreditPlanDto) {
    setFeedback(null);
    setConsentBlocked(false);
    // ★ 소멸 정책 명시 동의 하드 게이트(설계 8.1). 빌링키 발급 호출 전에 반드시 체크되어야 한다.
    if (!expiryConsent) {
      setConsentBlocked(true);
      return;
    }
    if (!PAYMENT_READY) return;
    setPendingCode(plan.code);
    try {
      const issued = await requestIssueBillingKey({
        storeId: PORTONE_STORE_ID,
        channelKey: PORTONE_BILLING_CHANNEL_KEY,
        billingKeyMethod: "CARD",
      });
      if (issued?.code || !issued?.billingKey) {
        throw new Error(issued?.message ?? "빌링키 발급이 취소되었거나 실패했습니다.");
      }
      const res = await fetch("/api/web/plans/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: plan.code, billingKey: issued.billingKey }),
      });
      const result = (await res.json()) as ActionResult<CreditSubscribeResultDto>;
      if (!res.ok || !result.ok || !result.data) {
        throw new Error(result.error?.message ?? "구독을 시작하지 못했습니다.");
      }
      setSubscription(result.data.subscription);
      setFeedback({
        kind: "subscribed",
        grantedCredits: result.data.grantedCredits,
        periodEnd: result.data.subscription.currentPeriodEnd,
        planName: result.data.subscription.planName,
      });
      void load();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "구독을 시작하지 못했습니다.",
      });
    } finally {
      setPendingCode(null);
    }
  }

  async function handleChange(plan: CreditPlanDto) {
    setFeedback(null);
    setPendingCode(plan.code);
    try {
      const res = await fetch("/api/web/plans/change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: plan.code }),
      });
      const result = (await res.json()) as ActionResult<CreditPlanChangeResultDto>;
      if (!res.ok || !result.ok || !result.data) {
        throw new Error(result.error?.message ?? "플랜을 변경하지 못했습니다.");
      }
      setSubscription(result.data.subscription);
      if (result.data.kind === "upgraded") {
        setFeedback({
          kind: "upgraded",
          grantedCredits: result.data.grantedCredits ?? 0,
          planName: result.data.subscription.planName,
        });
      } else {
        setFeedback({ kind: "downgrade_scheduled", planName: plan.name });
      }
      void load();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "플랜을 변경하지 못했습니다.",
      });
    } finally {
      setPendingCode(null);
    }
  }

  const busy = pendingCode !== null;

  return (
    <div className="flex flex-col gap-8">
      <FeedbackBanner feedback={feedback} />

      {loadError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {!PAYMENT_READY ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          <Info className="size-4 shrink-0" aria-hidden="true" />
          <span>결제 준비 중입니다. 곧 구독을 시작할 수 있습니다.</span>
        </div>
      ) : null}

      {/* ★ 소멸 정책 명시 동의 체크박스 — 구독 결제 전 하드 게이트(설계 8.1). */}
      {isLoggedIn && subscription === null ? (
        <ExpiryConsent
          checked={expiryConsent}
          onChange={(v) => {
            setExpiryConsent(v);
            if (v) setConsentBlocked(false);
          }}
          blocked={consentBlocked}
        />
      ) : null}

      <section aria-label="크레딧 플랜" className="grid gap-4 md:grid-cols-3">
        {loading && plans.length === 0
          ? Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="h-72" />
              </Card>
            ))
          : plans.map((plan) => (
              <PlanCard
                key={plan.code}
                plan={plan}
                subscription={subscription}
                isLoggedIn={isLoggedIn}
                paymentReady={PAYMENT_READY}
                pending={pendingCode === plan.code}
                disabled={busy}
                onSubscribe={() => void handleSubscribe(plan)}
                onChange={() => void handleChange(plan)}
              />
            ))}
      </section>

      <CreditExplainer plans={plans} />

      <TopupComparison products={products} />

      <PolicySummary />
    </div>
  );
}

function ExpiryConsent({
  checked,
  onChange,
  blocked,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  blocked: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border bg-muted/35 p-4">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id="plan-expiry-consent"
          checked={checked}
          aria-describedby="plan-expiry-consent-description"
          aria-invalid={blocked ? true : undefined}
          onCheckedChange={(v) => onChange(v === true)}
        />
        <div className="min-w-0 flex-1">
          <FieldLabel
            htmlFor="plan-expiry-consent"
            className="block text-[13px] font-semibold leading-[1.45] text-foreground"
          >
            지급 크레딧은 60일 후 소멸됩니다. 이에 동의합니다.
          </FieldLabel>
          <p
            id="plan-expiry-consent-description"
            className="mt-1 text-[12px] leading-[1.55] text-muted-foreground"
          >
            플랜으로 지급되는 월간 크레딧은 지급 시점부터 60일(2주기)이 지나면 소멸합니다. flex 플랜은 90일(3주기)까지
            이월됩니다. 구독을 시작하려면 이 소멸 정책에 동의해야 합니다.
          </p>
          {blocked ? (
            <p role="alert" className="mt-2 text-[12px] font-medium text-destructive">
              구독을 시작하려면 크레딧 소멸 정책에 먼저 동의해 주세요.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  subscription,
  isLoggedIn,
  paymentReady,
  pending,
  disabled,
  onSubscribe,
  onChange,
}: {
  plan: CreditPlanDto;
  subscription: CreditSubscriptionDto | null;
  isLoggedIn: boolean;
  paymentReady: boolean;
  pending: boolean;
  disabled: boolean;
  onSubscribe: () => void;
  onChange: () => void;
}) {
  const isCurrent = subscription?.planCode === plan.code;
  const hasSubscription = subscription !== null;
  const bonusPct = Math.round(plan.bonusRate * 100);
  const bullets = featureBullets(plan);

  return (
    <Card className={isCurrent ? "flex flex-col justify-between border-primary" : "flex flex-col justify-between"}>
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xl">{plan.name}</CardTitle>
          {isCurrent ? <StatusBadge tone="success">이용 중</StatusBadge> : null}
        </div>
        <CardDescription>
          <span className="text-2xl font-semibold text-foreground">
            {plan.monthlyPriceKrw.toLocaleString("ko-KR")}원
          </span>
          <span className="ml-1 text-sm">/ 월</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="rounded-[var(--radius-md)] border bg-muted/30 p-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold text-foreground">
              {plan.monthlyCredits.toLocaleString("ko-KR")}
            </span>
            <span className="text-sm text-muted-foreground">크레딧 / 월</span>
          </div>
          {bonusPct > 0 ? (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
              <Sparkles className="size-3.5" aria-hidden="true" />
              보너스율 +{bonusPct}%
            </span>
          ) : null}
        </div>

        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <div className="mt-auto">
          <PlanCta
            plan={plan}
            isCurrent={isCurrent}
            hasSubscription={hasSubscription}
            isLoggedIn={isLoggedIn}
            paymentReady={paymentReady}
            pending={pending}
            disabled={disabled}
            onSubscribe={onSubscribe}
            onChange={onChange}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function PlanCta({
  plan,
  isCurrent,
  hasSubscription,
  isLoggedIn,
  paymentReady,
  pending,
  disabled,
  onSubscribe,
  onChange,
}: {
  plan: CreditPlanDto;
  isCurrent: boolean;
  hasSubscription: boolean;
  isLoggedIn: boolean;
  paymentReady: boolean;
  pending: boolean;
  disabled: boolean;
  onSubscribe: () => void;
  onChange: () => void;
}) {
  if (!isLoggedIn) {
    return (
      <a
        href={`/login?callbackUrl=${encodeURIComponent("/pricing")}`}
        className={buttonVariants({ variant: "default", size: "default", className: "w-full" })}
      >
        로그인 후 구독
      </a>
    );
  }
  if (isCurrent) {
    return (
      <Button variant="outline" disabled className="w-full">
        현재 이용 중
      </Button>
    );
  }
  if (hasSubscription) {
    // 이미 구독 중 → 다른 플랜은 변경(빌링키 재발급 불필요).
    return (
      <Button variant="outline" onClick={onChange} disabled={disabled} aria-busy={pending} className="w-full">
        {pending ? <Spinner /> : "이 플랜으로 변경"}
      </Button>
    );
  }
  // 구독 없음 → 구독하기(소멸 동의 + 빌링키 발급).
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            onClick={onSubscribe}
            disabled={disabled || !paymentReady}
            aria-busy={pending}
            className="w-full"
          >
            {pending ? <Spinner /> : paymentReady ? "구독하기" : "결제 준비 중"}
          </Button>
        }
      />
      {!paymentReady ? <TooltipContent>결제 준비 중</TooltipContent> : null}
    </Tooltip>
  );
}

function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  if (feedback.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span>{feedback.message}</span>
      </div>
    );
  }
  let message: string;
  if (feedback.kind === "subscribed") {
    message = `${feedback.planName} 구독을 시작했습니다. ${feedback.grantedCredits.toLocaleString("ko-KR")} 크레딧이 지급되었습니다. 다음 결제일: ${formatDate(feedback.periodEnd)}.`;
  } else if (feedback.kind === "upgraded") {
    message = `업그레이드 완료. ${feedback.planName} 플랜으로 전환되어 ${feedback.grantedCredits.toLocaleString("ko-KR")} 크레딧이 지급되었습니다.`;
  } else {
    message = `${feedback.planName} 플랜으로 변경이 예약되었습니다. 다음 결제일부터 적용됩니다.`;
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-[var(--radius-md)] border border-primary/40 bg-primary/10 px-4 py-3 text-sm text-foreground"
    >
      <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function CreditExplainer({ plans }: { plans: CreditPlanDto[] }) {
  // 요율 기반 예시 소모량은 플랜 독립적 → 대표 플랜 하나의 exampleUsages 를 렌더(설계 10.1).
  const usages = plans.find((p) => p.exampleUsages.length > 0)?.exampleUsages ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">크레딧이란?</CardTitle>
        <CardDescription>
          1 크레딧 = 1원 가치입니다. AI 작업(지원서 작성·첨삭·가이드)에 사용할 때 실제 사용량만큼 차감됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {usages.length > 0 ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border">
            <Table className="w-full text-sm">
              <TableCaption className="sr-only">기능별 예상 크레딧 소모량</TableCaption>
              <TableHeader className="bg-muted/40 text-muted-foreground">
                <TableRow>
                  <TableHead className="px-4 py-2 text-left font-medium">기능</TableHead>
                  <TableHead className="px-4 py-2 text-right font-medium">예상 소모</TableHead>
                  <TableHead className="px-4 py-2 text-right font-medium">월 예상 횟수</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usages.map((u) => (
                  <TableRow key={u.featureLabel} className="border-t">
                    <TableCell className="px-4 py-2 text-foreground">{u.featureLabel}</TableCell>
                    <TableCell className="px-4 py-2 text-right text-muted-foreground">
                      약 {u.approxCredits.toLocaleString("ko-KR")} 크레딧
                    </TableCell>
                    <TableCell className="px-4 py-2 text-right text-muted-foreground">
                      약 {u.approxCount.toLocaleString("ko-KR")}회
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">기능별 예상 소모량 정보를 준비 중입니다.</p>
        )}
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          예상 소모량은 요율 기반 추정치이며 실제 사용량(입력·출력 규모)에 따라 달라질 수 있습니다.
        </p>
      </CardContent>
    </Card>
  );
}

function TopupComparison({ products }: { products: CreditProductDto[] }) {
  if (products.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-lg">충전 상품 비교</CardTitle>
          <CardDescription>구독 없이 필요할 때만 크레딧을 충전할 수도 있습니다.</CardDescription>
        </div>
        <a href="/credits" className="text-sm font-medium text-primary hover:underline">
          충전하러 가기
        </a>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-[var(--radius-md)] border">
          <Table className="w-full text-sm">
            <TableCaption className="sr-only">충전 상품별 금액과 지급 크레딧</TableCaption>
            <TableHeader className="bg-muted/40 text-muted-foreground">
              <TableRow>
                <TableHead className="px-4 py-2 text-left font-medium">상품</TableHead>
                <TableHead className="px-4 py-2 text-right font-medium">결제 금액</TableHead>
                <TableHead className="px-4 py-2 text-right font-medium">지급 크레딧</TableHead>
                <TableHead className="px-4 py-2 text-right font-medium">보너스</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.code} className="border-t">
                  <TableCell className="px-4 py-2 text-foreground">{p.name}</TableCell>
                  <TableCell className="px-4 py-2 text-right text-muted-foreground">
                    {p.amountKrw.toLocaleString("ko-KR")}원
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right font-medium text-foreground">
                    {p.totalCredits.toLocaleString("ko-KR")}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right text-primary">
                    {p.bonusCredits > 0 ? `+${p.bonusCredits.toLocaleString("ko-KR")}` : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function PolicySummary() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">소멸 · 환불 정책</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm leading-6 text-muted-foreground">
        <p>
          <strong className="text-foreground">플랜 크레딧 소멸:</strong> 플랜으로 지급된 월간 크레딧은 지급 후
          60일(2주기)이 지나면 소멸합니다. flex 플랜은 90일(3주기)까지 이월됩니다.
        </p>
        <p>
          <strong className="text-foreground">충전 크레딧 유효기간:</strong> 충전으로 지급된 크레딧은 지급 후 5년까지
          사용할 수 있습니다.
        </p>
        <p>
          <strong className="text-foreground">환불:</strong> 결제 후 7일 이내 미사용분은 청약철회로 환불받을 수
          있습니다. 7일 이후에는 약관에 따른 임의 환불 정책이 적용됩니다.
        </p>
        <p>
          크레딧은 cunote 서비스 전용 이용권이며 현금 환급·양도·선물되지 않습니다. 만 19세 미만은 법정대리인 동의가
          필요합니다.
        </p>
        <p className="flex flex-wrap gap-3">
          <a href="/terms" className="font-medium text-primary hover:underline">
            이용약관
          </a>
          <a href="/privacy" className="font-medium text-primary hover:underline">
            개인정보처리방침
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

function featureBullets(plan: CreditPlanDto): string[] {
  const raw = plan.features;
  if (raw && typeof raw === "object") {
    const maybeBullets = (raw as { bullets?: unknown }).bullets;
    if (Array.isArray(maybeBullets)) {
      const strings = maybeBullets.filter((b): b is string => typeof b === "string");
      if (strings.length > 0) return strings;
    }
  }
  return DEFAULT_FEATURE_BULLETS[plan.code] ?? ["월간 크레딧 자동 충전", "충전 대비 높은 보너스율"];
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}
