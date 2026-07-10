"use client";

import type { ActionResult, CreditBalanceDto } from "@cunote/contracts";
import { Coins } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * 잔액 위젯(설계 10.5) — 인증 레이아웃 헤더에 현재 사용 가능 크레딧(available)을 표시.
 * lowBalance 면 주황 배지. /credits 로 링크. 데이터 페칭은 기존 컨벤션(client fetch).
 */
export function CreditBalanceWidget() {
  const [balance, setBalance] = useState<CreditBalanceDto | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/web/credits/balance");
        if (res.status === 401) {
          // 비로그인·데모 — 위젯 숨김.
          if (!cancelled) setHidden(true);
          return;
        }
        const result = (await res.json()) as ActionResult<CreditBalanceDto>;
        if (!cancelled && result.ok && result.data) setBalance(result.data);
        else if (!cancelled && !result.ok) setHidden(true);
      } catch {
        if (!cancelled) setHidden(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden) return null;

  const available = balance?.available ?? null;
  const low = balance?.lowBalance ?? false;

  return (
    <a
      href="/credits"
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
        low
          ? "border-amber-500/40 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25"
          : "border-border bg-muted/40 text-foreground hover:bg-muted",
      ].join(" ")}
      aria-label="크레딧 충전"
      title={low ? "잔액이 부족합니다. 충전이 필요합니다." : "크레딧 잔액"}
    >
      <Coins className="size-4 text-primary" aria-hidden="true" />
      <span>{available === null ? "…" : available.toLocaleString("ko-KR")}</span>
      {low ? <span className="text-xs">부족</span> : null}
    </a>
  );
}
