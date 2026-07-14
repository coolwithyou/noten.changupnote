import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface PrecisionGaugeProps {
  /** 채움 비율(0~100). 범위를 벗어나면 clamp 처리. */
  pct: number;
  /** 좌측 라벨(예: "정밀도 92%"). */
  label: string;
  /** 좌하단 캡션(예: "22개 축 중 20개 확인됨"). */
  caption: string;
  /** 우하단 메타(예: "3분 전 갱신"). */
  meta: string;
  /** 증감 뱃지(옵션, 예: "+9%p"). */
  delta?: string;
  className?: string;
}

/**
 * 정밀도 게이지 — 8px 바 + 민트 그라디언트 채움 + 옵션 delta 뱃지.
 * 시각 스펙은 docs/design/2026-07-14-components/PrecisionGauge.dc.html을 토큰으로 재현.
 */
export function PrecisionGauge({ pct, label, caption, meta, delta, className }: PrecisionGaugeProps) {
  const fill = Math.max(0, Math.min(100, pct));
  return (
    <div className={className}>
      <div className="flex items-center gap-3.5">
        <span className="text-[15px] font-extrabold whitespace-nowrap text-ink tabular-nums">
          {label}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-border-subtle">
          <div className="h-full rounded-full bg-grad-gauge" style={{ width: `${fill}%` }} />
        </div>
        {delta ? (
          <Badge className="h-auto rounded-[8px] bg-brand-mint-soft px-2 py-[3px] text-[12.5px] font-extrabold text-brand-mint-ink tabular-nums">
            {delta}
          </Badge>
        ) : null}
      </div>
      <div className={cn("mt-2 flex justify-between gap-4 text-[12.5px] text-text-tertiary")}>
        <span>{caption}</span>
        <span className="whitespace-nowrap tabular-nums">{meta}</span>
      </div>
    </div>
  );
}
