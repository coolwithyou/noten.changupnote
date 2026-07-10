"use client";

import type {
  ActionResult,
  CreditBillingKeyResultDto,
  CreditPlanCancelResultDto,
  CreditPlansDto,
  CreditSubscriptionDto,
} from "@cunote/contracts";
import { AlertTriangle, CreditCard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/app/status-badge";
import { requestIssueBillingKey } from "@/features/credits/portoneBrowser";

const PORTONE_STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID?.trim() ?? "";
const PORTONE_BILLING_CHANNEL_KEY = process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSS_BILLING?.trim() ?? "";
const PAYMENT_READY = PORTONE_STORE_ID.length > 0 && PORTONE_BILLING_CHANNEL_KEY.length > 0;

export function CreditPlanSection() {
  const [subscription, setSubscription] = useState<CreditSubscriptionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    setLoading(true);
    try {
      const res = await fetch("/api/web/plans").then(
        (r) => r.json() as Promise<ActionResult<CreditPlansDto>>,
      );
      if (signal?.cancelled) return;
      if (res.ok && res.data) {
        setSubscription(res.data.subscription);
        setLoadError(null);
      } else {
        setLoadError(res.error?.message ?? "크레딧 플랜 정보를 불러오지 못했습니다.");
      }
    } catch {
      if (!signal?.cancelled) setLoadError("크레딧 플랜 정보를 불러오지 못했습니다.");
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  async function confirmCancel() {
    setActionError(null);
    setCanceling(true);
    try {
      const res = await fetch("/api/web/plans/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await res.json()) as ActionResult<CreditPlanCancelResultDto>;
      if (!res.ok || !result.ok || !result.data) {
        throw new Error(result.error?.message ?? "구독을 해지하지 못했습니다.");
      }
      toast.success(`${formatDate(result.data.periodEnd)}에 해지됩니다.`);
      setCancelOpen(false);
      void load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "구독을 해지하지 못했습니다.");
    } finally {
      setCanceling(false);
    }
  }

  async function replaceBillingKey() {
    setActionError(null);
    if (!PAYMENT_READY) return;
    setReplacingKey(true);
    try {
      const issued = await requestIssueBillingKey({
        storeId: PORTONE_STORE_ID,
        channelKey: PORTONE_BILLING_CHANNEL_KEY,
        billingKeyMethod: "CARD",
      });
      if (issued?.code || !issued?.billingKey) {
        throw new Error(issued?.message ?? "빌링키 발급이 취소되었거나 실패했습니다.");
      }
      const res = await fetch("/api/web/plans/billing-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billingKey: issued.billingKey }),
      });
      const result = (await res.json()) as ActionResult<CreditBillingKeyResultDto>;
      if (!res.ok || !result.ok || !result.data) {
        throw new Error(result.error?.message ?? "빌링키를 교체하지 못했습니다.");
      }
      setSubscription((prev) =>
        prev ? { ...prev, cardBrand: result.data!.cardBrand, cardLast4: result.data!.cardLast4 } : prev,
      );
      toast.success("카드가 변경되었습니다.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "빌링키를 교체하지 못했습니다.");
    } finally {
      setReplacingKey(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <span className="text-xs font-medium uppercase text-muted-foreground">크레딧 플랜</span>
          <h2 className="mt-1 text-lg font-semibold tracking-normal">AI 크레딧 구독</h2>
        </div>
        {subscription ? (
          <StatusBadge tone={statusTone(subscription.status)}>{statusLabel(subscription.status)}</StatusBadge>
        ) : (
          <CreditCard className="size-5 text-muted-foreground" aria-hidden />
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {actionError ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner />
            <span>불러오는 중…</span>
          </div>
        ) : loadError ? (
          <p className="py-2 text-sm text-muted-foreground">{loadError}</p>
        ) : subscription === null ? (
          <div className="rounded-[var(--radius-lg)] border bg-muted/30 p-4">
            <strong className="block text-sm font-semibold text-foreground">
              구독 중인 크레딧 플랜이 없습니다.
            </strong>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              매달 크레딧을 자동으로 충전받고 더 높은 보너스율로 이용할 수 있습니다.
            </p>
            <a className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-3`} href="/pricing">
              플랜 보기
            </a>
          </div>
        ) : (
          <SubscriptionDetails
            subscription={subscription}
            paymentReady={PAYMENT_READY}
            canceling={canceling}
            replacingKey={replacingKey}
            onOpenCancel={() => setCancelOpen(true)}
            onReplaceKey={() => void replaceBillingKey()}
          />
        )}
      </CardContent>

      {subscription ? (
        <CancelModal
          open={cancelOpen}
          subscription={subscription}
          busy={canceling}
          onOpenChange={(open) => {
            if (!canceling) setCancelOpen(open);
          }}
          onConfirm={() => void confirmCancel()}
        />
      ) : null}
    </Card>
  );
}

function SubscriptionDetails({
  subscription,
  paymentReady,
  canceling,
  replacingKey,
  onOpenCancel,
  onReplaceKey,
}: {
  subscription: CreditSubscriptionDto;
  paymentReady: boolean;
  canceling: boolean;
  replacingKey: boolean;
  onOpenCancel: () => void;
  onReplaceKey: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="rounded-[var(--radius-lg)] border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-base font-semibold text-foreground">{subscription.planName}</strong>
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">다음 결제일</dt>
            <dd className="font-medium text-foreground">{formatDate(subscription.currentPeriodEnd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">다음 결제 금액</dt>
            <dd className="font-medium text-foreground">
              {subscription.nextBillingAmountKrw.toLocaleString("ko-KR")}원
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">결제 카드</dt>
            <dd className="font-medium text-foreground">{cardLabel(subscription)}</dd>
          </div>
        </dl>

        {subscription.pendingPlanCode ? (
          <p className="mt-3 text-sm text-muted-foreground">
            다음 주기부터 {subscription.pendingPlanCode} 플랜으로 변경 예정입니다.
          </p>
        ) : null}
        {subscription.cancelAtPeriodEnd ? (
          <p className="mt-1 text-sm font-medium text-amber-600">
            {formatDate(subscription.currentPeriodEnd)}에 해지 예정입니다.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/pricing">
          플랜 변경
        </a>
        <Button
          variant="outline"
          size="sm"
          onClick={onReplaceKey}
          disabled={!paymentReady || replacingKey}
          aria-busy={replacingKey}
        >
          {replacingKey ? <Spinner /> : paymentReady ? "빌링키 교체" : "결제 준비 중"}
        </Button>
        {!subscription.cancelAtPeriodEnd ? (
          <Button variant="destructive" size="sm" onClick={onOpenCancel} disabled={canceling}>
            해지
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CancelModal({
  open,
  subscription,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  subscription: CreditSubscriptionDto;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>크레딧 플랜을 해지할까요?</AlertDialogTitle>
          <AlertDialogDescription>
            해지해도 현재 주기 종료일인{" "}
            <strong className="text-foreground">{formatDate(subscription.currentPeriodEnd)}</strong>까지는 플랜이
            유지됩니다. 이후 자동 결제가 중단됩니다.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 text-sm leading-6 text-muted-foreground">
          <p>
            <strong className="text-foreground">플랜 크레딧 소멸:</strong> 이미 지급된 플랜 크레딧은 각 지급 시점부터
            60일(2주기)이 지나면 소멸합니다(flex 플랜은 90일). 해지하더라도 아직 소멸하지 않은 크레딧은 해당 소멸일까지
            그대로 사용할 수 있습니다.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>계속 이용</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <Spinner /> : "해지하기"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function cardLabel(sub: CreditSubscriptionDto): string {
  if (!sub.cardBrand && !sub.cardLast4) return "카드 정보 없음";
  const brand = sub.cardBrand ?? "카드";
  const last4 = sub.cardLast4 ? `····${sub.cardLast4}` : "";
  return `${brand} ${last4}`.trim();
}

function statusTone(status: CreditSubscriptionDto["status"]): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "past_due") return "warning";
  if (status === "canceled" || status === "expired") return "danger";
  return "neutral";
}

function statusLabel(status: CreditSubscriptionDto["status"]): string {
  if (status === "active") return "이용 중";
  if (status === "past_due") return "결제 실패";
  if (status === "canceled") return "해지됨";
  if (status === "expired") return "만료됨";
  return "대기";
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}
