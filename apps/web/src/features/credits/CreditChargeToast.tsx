"use client";

import { Coins, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 차감 영수증 토스트(설계 10.5 — 투명성/신뢰의 핵심 장치).
 *
 * LLM 작업 완료 응답의 `creditsCharged` 를 "N 크레딧 사용됨"으로 표시한다.
 * 외부 토스트 라이브러리(sonner 등)를 추가하지 않고 자체 렌더한다(의존성 0 규약).
 *
 * 사용 패턴(제어 컴포넌트):
 * ```tsx
 * const [charged, setCharged] = useState<number | null>(null);
 * // ...작업 완료 응답에서: setCharged(result.data.creditsCharged);
 * {charged !== null ? (
 *   <CreditChargeToast creditsCharged={charged} onDismiss={() => setCharged(null)} />
 * ) : null}
 * ```
 *
 * @param creditsCharged 이번 작업에서 차감된 크레딧(0 이상). 0이면 "무료"로 표시.
 * @param onDismiss 닫힘(자동/수동) 콜백.
 * @param durationMs 자동 닫힘까지 시간(기본 5000ms). 0이면 자동 닫힘 없음.
 */
export function CreditChargeToast({
  creditsCharged,
  onDismiss,
  durationMs = 5000,
}: {
  creditsCharged: number;
  onDismiss?: () => void;
  durationMs?: number;
}) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (durationMs <= 0) return;
    const timer = setTimeout(() => {
      setLeaving(true);
      // 페이드아웃 후 실제 dismiss.
      setTimeout(() => onDismiss?.(), 180);
    }, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDismiss]);

  const isFree = creditsCharged <= 0;

  return (
    <div
      role="status"
      aria-live="polite"
      // width 는 min()+calc() 콤마가 들어가 Tailwind arbitrary 로는 dev(Turbopack)에서 미생성 →
      // 인라인 스타일(CSS 변수 성격)로 우회한다(프로젝트 메모리 규약).
      style={{ width: "min(22rem, calc(100vw - 2rem))" }}
      className={cn(
        "fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-[var(--radius-lg)] border bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-subtle)] transition-opacity duration-150",
        leaving ? "opacity-0" : "opacity-100",
      )}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
        aria-hidden="true"
      >
        <Coins className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col">
        <strong className="text-sm font-semibold text-foreground">
          {isFree ? "무료로 처리되었습니다" : `${creditsCharged.toLocaleString("ko-KR")} 크레딧 사용됨`}
        </strong>
        <span className="text-xs text-muted-foreground">
          {isFree
            ? "이 작업은 크레딧을 소모하지 않았습니다."
            : "사용 내역은 내 계정 · 사용량에서 확인할 수 있습니다."}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => {
          setLeaving(true);
          setTimeout(() => onDismiss?.(), 180);
        }}
        className="ml-auto shrink-0 text-muted-foreground"
        aria-label="닫기"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
