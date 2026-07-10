"use client";

import type {
  ActionResult,
  CreditBalanceDto,
  CreditCheckoutDto,
  CreditProductListDto,
} from "@cunote/contracts";
import { AlertTriangle, Coins, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { requestPayment } from "./portoneBrowser";

type ProductItem = CreditProductListDto["products"][number];

export function CreditsPurchasePanel() {
  const [balance, setBalance] = useState<CreditBalanceDto | null>(null);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [balanceRes, productsRes] = await Promise.all([
          fetch("/api/web/credits/balance").then((r) => r.json() as Promise<ActionResult<CreditBalanceDto>>),
          fetch("/api/web/credits/products").then((r) => r.json() as Promise<ActionResult<CreditProductListDto>>),
        ]);
        if (cancelled) return;
        if (balanceRes.ok && balanceRes.data) setBalance(balanceRes.data);
        if (productsRes.ok && productsRes.data) setProducts(productsRes.data.products);
        if (!productsRes.ok) setLoadError(productsRes.error?.message ?? "충전 상품을 불러오지 못했습니다.");
      } catch {
        if (!cancelled) setLoadError("데이터를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startCheckout(product: ProductItem) {
    setCheckoutError(null);
    setPendingCode(product.code);
    try {
      const res = await fetch("/api/web/credits/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productCode: product.code }),
      });
      const result = (await res.json()) as ActionResult<CreditCheckoutDto>;
      if (!res.ok || !result.ok || !result.data) {
        throw new Error(result.error?.message ?? "결제를 시작하지 못했습니다.");
      }
      const checkout = result.data;
      const origin = window.location.origin;
      const redirectUrl = `${origin}/credits/complete?paymentId=${encodeURIComponent(checkout.paymentId)}`;

      const response = await requestPayment({
        storeId: checkout.storeId,
        channelKey: checkout.channelKey,
        paymentId: checkout.paymentId,
        orderName: checkout.orderName,
        totalAmount: checkout.totalAmount,
        redirectUrl,
      });

      // PC(iframe): response 반환. 실패면 code 포함.
      if (response?.code) {
        throw new Error(response.message ?? "결제가 취소되었거나 실패했습니다.");
      }
      // 성공(또는 리다이렉트 전) — 완료 페이지로 이동해 서버 검증.
      window.location.href = redirectUrl;
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "결제를 시작하지 못했습니다.");
      setPendingCode(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <BalanceSummary balance={balance} loading={loading} />

      {loadError ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">{loadError}</CardContent>
        </Card>
      ) : null}

      {checkoutError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>{checkoutError}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="충전 상품" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading && products.length === 0
          ? Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="h-40" />
              </Card>
            ))
          : products.map((product) => (
              <ProductCard
                key={product.code}
                product={product}
                pending={pendingCode === product.code}
                disabled={pendingCode !== null}
                onSelect={() => startCheckout(product)}
              />
            ))}
      </section>

      <p className="text-xs leading-6 text-muted-foreground">
        결제는 포트원(PortOne)을 통해 안전하게 처리됩니다. 크레딧은 자사 서비스 전용이며 현금 환급·양도되지 않습니다.
        결제 후 7일 이내 미사용분은 청약철회로 환불받을 수 있습니다.
      </p>
    </div>
  );
}

function BalanceSummary({ balance, loading }: { balance: CreditBalanceDto | null; loading: boolean }) {
  const soon = balance?.expiringSoon ?? [];
  const expiringTotal = soon.reduce((s, l) => s + l.remaining, 0);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardDescription>현재 사용 가능 크레딧</CardDescription>
          <CardTitle className="flex items-center gap-2 text-3xl">
            <Coins className="size-6 text-primary" aria-hidden="true" />
            {loading && !balance ? <Spinner /> : (balance?.available ?? 0).toLocaleString("ko-KR")}
          </CardTitle>
        </div>
        {balance?.lowBalance ? (
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-600">
            잔액 부족
          </span>
        ) : null}
      </CardHeader>
      {expiringTotal > 0 ? (
        <CardContent className="flex items-center gap-2 pt-0 text-sm text-amber-600">
          <AlertTriangle className="size-4" aria-hidden="true" />
          곧 만료 예정: {expiringTotal.toLocaleString("ko-KR")} 크레딧
        </CardContent>
      ) : null}
    </Card>
  );
}

function ProductCard({
  product,
  pending,
  disabled,
  onSelect,
}: {
  product: ProductItem;
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const hasBonus = product.bonusCredits > 0;
  return (
    <Card className="flex flex-col justify-between">
      <CardHeader>
        <CardTitle className="text-xl">{product.name}</CardTitle>
        <CardDescription>
          {product.totalCredits.toLocaleString("ko-KR")} 크레딧
          {hasBonus ? (
            <span className="ml-1 inline-flex items-center gap-1 text-primary">
              <Sparkles className="size-3.5" aria-hidden="true" />
              보너스 +{product.bonusCredits.toLocaleString("ko-KR")}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-2xl font-semibold text-foreground">
          {product.amountKrw.toLocaleString("ko-KR")}원
        </div>
        <Button onClick={onSelect} disabled={disabled} aria-busy={pending}>
          {pending ? <Spinner /> : "충전하기"}
        </Button>
      </CardContent>
    </Card>
  );
}
