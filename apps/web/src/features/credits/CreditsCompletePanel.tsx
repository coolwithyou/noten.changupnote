"use client";

import type { ActionResult, CreditCheckoutCompleteDto } from "@cunote/contracts";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

type Phase = "verifying" | "paid" | "pending" | "failed" | "already" | "error";

const POLL_ATTEMPTS = 3;
const POLL_DELAY_MS = 2500;

export function CreditsCompletePanel({ paymentId }: { paymentId: string | null }) {
  const [phase, setPhase] = useState<Phase>("verifying");
  const [data, setData] = useState<CreditCheckoutCompleteDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!paymentId) {
      setPhase("error");
      setMessage("결제 식별자가 없습니다.");
      return;
    }

    let cancelled = false;

    async function complete(attempt: number): Promise<void> {
      try {
        const res = await fetch("/api/web/credits/checkout/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentId }),
        });
        const result = (await res.json()) as ActionResult<CreditCheckoutCompleteDto>;
        if (cancelled) return;

        if (res.status === 409) {
          setPhase("failed");
          setMessage("결제 금액이 주문과 일치하지 않습니다. 고객센터로 문의해 주세요.");
          return;
        }
        if (!res.ok || !result.ok || !result.data) {
          setPhase("error");
          setMessage(result.error?.message ?? "결제 확인에 실패했습니다.");
          return;
        }

        const payload = result.data;
        setData(payload);

        if (payload.status === "paid") {
          setPhase("paid");
        } else if (payload.status === "already") {
          setPhase("already");
        } else if (payload.status === "failed") {
          setPhase("failed");
          setMessage(payload.reason ?? "결제가 실패했습니다.");
        } else {
          // pending — 웹훅 지연. 폴링 3회.
          if (attempt < POLL_ATTEMPTS) {
            setPhase("pending");
            setTimeout(() => void complete(attempt + 1), POLL_DELAY_MS);
          } else {
            setPhase("pending");
          }
        }
      } catch (error) {
        if (cancelled) return;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "결제 확인에 실패했습니다.");
      }
    }

    void complete(1);
    return () => {
      cancelled = true;
    };
  }, [paymentId]);

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <StatusIcon phase={phase} />
        <CardTitle className="text-2xl">{titleFor(phase)}</CardTitle>
        <CardDescription>{descriptionFor(phase, data, message)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        {(phase === "paid" || phase === "already") && data ? (
          <div className="flex flex-col items-center gap-1">
            {data.grantedCredits > 0 ? (
              <span className="text-lg font-semibold text-foreground">
                +{data.grantedCredits.toLocaleString("ko-KR")} 크레딧
              </span>
            ) : null}
            {data.balance !== null ? (
              <span className="text-sm text-muted-foreground">
                현재 잔액 {data.balance.toLocaleString("ko-KR")} 크레딧
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <a href="/credits">
            <Button variant={phase === "paid" || phase === "already" ? "secondary" : "default"}>
              충전 페이지로
            </Button>
          </a>
          {phase === "paid" || phase === "already" ? (
            <a href="/dashboard">
              <Button>대시보드로</Button>
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusIcon({ phase }: { phase: Phase }) {
  if (phase === "paid" || phase === "already") {
    return <CheckCircle2 className="size-12 text-emerald-500" aria-hidden="true" />;
  }
  if (phase === "failed" || phase === "error") {
    return <XCircle className="size-12 text-destructive" aria-hidden="true" />;
  }
  if (phase === "pending") {
    return <Clock className="size-12 text-amber-500" aria-hidden="true" />;
  }
  return <Spinner className="size-8" />;
}

function titleFor(phase: Phase): string {
  switch (phase) {
    case "paid":
    case "already":
      return "충전이 완료되었습니다";
    case "pending":
      return "결제 반영 중입니다";
    case "failed":
      return "결제가 완료되지 않았습니다";
    case "error":
      return "결제 확인에 실패했습니다";
    default:
      return "결제를 확인하는 중입니다";
  }
}

function descriptionFor(
  phase: Phase,
  data: CreditCheckoutCompleteDto | null,
  message: string | null,
): string {
  if (message) return message;
  switch (phase) {
    case "paid":
    case "already":
      return "크레딧이 지급되었습니다.";
    case "pending":
      return "결제는 확인되었으나 반영이 지연되고 있습니다. 잠시 후 자동으로 반영됩니다.";
    case "failed":
      return (data?.reason ?? "결제가 취소되었거나 실패했습니다.") + " 다시 시도해 주세요.";
    case "error":
      return "잠시 후 다시 시도하거나 고객센터로 문의해 주세요.";
    default:
      return "결제 결과를 확인하고 있습니다.";
  }
}
