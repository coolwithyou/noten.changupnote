"use client";

import type { ActionResult, CreditBalanceDto } from "@cunote/contracts";
import { ArrowRight, Coins } from "lucide-react";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/app/status-badge";

/**
 * /account 허브 "크레딧·사용량" 카드(설계 10.4).
 * 현재 사용 가능 잔액(available)을 표시하고 /account/usage 로 연결한다.
 * 잔액은 balance 가 아니라 available 을 표시(규약 — hold·버퍼 반영).
 */
export function AccountCreditsCard() {
  const [balance, setBalance] = useState<CreditBalanceDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/web/credits/balance");
        const result = (await res.json()) as ActionResult<CreditBalanceDto>;
        if (!cancelled && result.ok && result.data) setBalance(result.data);
      } catch {
        // 카드 잔액은 보조 — 실패 시 "…" 유지.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const available = balance?.available ?? null;
  const low = balance?.lowBalance ?? false;

  return (
    <Card>
      <CardHeader>
        <CardAction>
          <StatusBadge tone={low ? "warning" : "brand"}>{low ? "잔액 부족" : "크레딧"}</StatusBadge>
        </CardAction>
        <div className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
          <Coins />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">크레딧·사용량</span>
          <h2 className="text-base font-semibold text-foreground">
            {available === null ? "…" : `${available.toLocaleString("ko-KR")} 크레딧`}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            사용 가능 잔액입니다. AI 작업 사용 내역·크레딧 원장·결제 내역을 확인합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className={buttonVariants({ variant: "secondary", size: "sm" })} href="/account/usage">
            사용량 상세
            <ArrowRight data-icon="inline-end" />
          </a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/credits">
            충전하기
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
