"use client";

import type { ActionResult, CreditEstimateDto } from "@cunote/contracts";
import { Coins } from "lucide-react";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 사전 견적 배지(설계 10.5 — 필수 규약, 레드팀 M2-제품).
 *
 * **의무 규약**: 크레딧을 소모하는 모든 작업(withCreditMetering 을 통과하는 LLM 기능)의
 * 시작 버튼 옆에 이 컴포넌트를 렌더해, 사용자가 402(잔액 부족)를 사후에 만나기 전에
 * "예상 약 N 크레딧 · 잔액 M (부족)"을 미리 보게 한다. 신규 LLM 기능을 구현할 때
 * withCreditMetering 사용과 함께 이 UI 배치가 강제된다.
 *
 * - `GET /api/web/credits/estimate?feature&inputHint` 를 호출해 서버 계산 결과만 표시한다
 *   (요율 원시값은 노출하지 않는다 — 4.13).
 * - 요율 미정의(503 pricing_unavailable)면 배지를 숨긴다(잘못된 0원 표시를 만들지 않는다).
 *
 * @param feature 3.2 featureCode (예: "application_draft").
 * @param inputHint 입력 토큰 힌트(선택). 미지정 시 서버 기본값 사용.
 * @param className 래퍼 클래스 오버라이드.
 */
export function CreditEstimateBadge({
  feature,
  inputHint,
  className,
}: {
  feature: string;
  inputHint?: number;
  className?: string;
}) {
  const [estimate, setEstimate] = useState<CreditEstimateDto | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const query = new URLSearchParams({ feature });
        if (typeof inputHint === "number" && inputHint > 0) {
          query.set("inputHint", String(Math.trunc(inputHint)));
        }
        const res = await fetch(`/api/web/credits/estimate?${query.toString()}`);
        if (!res.ok) {
          // 401(비로그인) · 503(요율 미정의) 등 — 배지 숨김.
          if (!cancelled) setHidden(true);
          return;
        }
        const result = (await res.json()) as ActionResult<CreditEstimateDto>;
        if (!cancelled && result.ok && result.data) setEstimate(result.data);
        else if (!cancelled) setHidden(true);
      } catch {
        if (!cancelled) setHidden(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [feature, inputHint]);

  if (hidden || !estimate) return null;

  const insufficient = !estimate.sufficient;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              insufficient
                ? "border-amber-500/40 bg-amber-500/15 text-amber-600"
                : "border-border bg-muted/40 text-muted-foreground",
              className,
            )}
          />
        }
      >
        <Coins className="size-3.5" aria-hidden="true" />
        <span>
          예상 약 {estimate.estimatedCredits.toLocaleString("ko-KR")} 크레딧 · 잔액{" "}
          {estimate.available.toLocaleString("ko-KR")}
        </span>
        {insufficient ? <span className="font-semibold">(부족)</span> : null}
      </TooltipTrigger>
      <TooltipContent>이 작업에 소모될 예상 크레딧입니다.</TooltipContent>
    </Tooltip>
  );
}
