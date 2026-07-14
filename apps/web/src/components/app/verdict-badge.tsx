import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * 판정 4상태 어휘 — 인터페이스 헌법 8조 "4상태 어휘"의 단일 원천.
 * 이 4개 외 상태를 발명하지 말 것(접수 예정 등 비판정 상태는 NoticeCard가 별도 처리).
 */
export type VerdictStatus = "open" | "one_answer" | "check_source" | "closed";

/** 상태별 고정 라벨. UI 어느 곳에서든 이 표기를 그대로 쓴다. */
export const VERDICT_LABEL: Record<VerdictStatus, string> = {
  open: "지금 신청 가능",
  one_answer: "답하면 확정",
  check_source: "원문 확인 필요",
  closed: "이번엔 어려움",
};

const VERDICT_CLASS: Record<VerdictStatus, string> = {
  open: "bg-verdict-open-bg text-verdict-open-fg",
  one_answer: "bg-verdict-answer-bg text-verdict-answer-fg",
  check_source: "bg-verdict-check-bg text-verdict-check-fg",
  closed: "bg-verdict-closed-bg text-verdict-closed-fg",
};

export interface VerdictBadgeProps
  extends Omit<ComponentProps<typeof Badge>, "variant" | "children"> {
  status: VerdictStatus;
}

/**
 * 판정 4상태 뱃지. 배경/텍스트 색은 globals.css의 --verdict-* 시맨틱 토큰만 참조한다.
 */
export function VerdictBadge({ status, className, ...props }: VerdictBadgeProps) {
  return (
    <Badge
      className={cn(
        "h-auto rounded-[8px] px-2.5 py-1 text-[12.5px] font-bold",
        VERDICT_CLASS[status],
        className,
      )}
      {...props}
    >
      {VERDICT_LABEL[status]}
    </Badge>
  );
}
