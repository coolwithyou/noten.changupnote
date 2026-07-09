"use client";

/**
 * 채팅 패널 플레이스홀더 (Apply Experience v2 · §4.3 · P2-5).
 *
 * Phase 3(채팅 코어)에서 실제 스트리밍 채팅으로 교체된다 — 인터페이스를 과도하게 설계하지 않는다.
 * 입력창은 비활성(placeholder)이고 전송 배선은 없다.
 */
import { MessageSquare } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ChatPanelPlaceholder({ variant = "dock" }: { variant?: "dock" | "front" }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-xl)] border bg-card p-4",
        variant === "front" ? "min-h-64" : "shrink-0",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
        이 사업에 대해 물어보세요
      </div>
      <p className="text-sm text-muted-foreground">
        공고 내용·자격·마감·작성 요령을 안내하는 채팅 도우미가 곧 제공됩니다. 준비되면 이 자리에서 바로
        대화할 수 있어요.
      </p>
      <Textarea
        placeholder="채팅은 곧 제공됩니다"
        disabled
        aria-label="채팅 입력(준비 중)"
        rows={variant === "front" ? 3 : 2}
      />
    </div>
  );
}
