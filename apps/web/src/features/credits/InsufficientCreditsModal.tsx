"use client";

import type { ActionResult, CreditProductListDto } from "@cunote/contracts";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * 402 insufficient_credits 메타(설계 6.4).
 * hold 버퍼(×1.2, credit_settings.hold_buffer_ratio)가 반영되어 required 가 커 보일 수 있다.
 */
export interface InsufficientCreditsMeta {
  required: number;
  available: number;
  shortfall: number;
}

/**
 * `ActionResult.error.meta` 에서 402 메타를 안전하게 뽑아낸다.
 * error.code === "insufficient_credits" 이고 세 숫자 필드가 모두 있을 때만 반환.
 * 402 를 전역 처리하는 fetch 래퍼/호출부에서 사용한다.
 */
export function parseInsufficientCreditsError(
  result: ActionResult<unknown> | null | undefined,
): InsufficientCreditsMeta | null {
  if (!result || result.ok) return null;
  if (result.error?.code !== "insufficient_credits") return null;
  const meta = result.error.meta;
  if (!meta) return null;
  const required = Number(meta.required);
  const available = Number(meta.available);
  const shortfall = Number(meta.shortfall);
  if (![required, available, shortfall].every((n) => Number.isFinite(n))) return null;
  return { required, available, shortfall };
}

/**
 * 크레딧 부족 모달(설계 10.5) — LLM 기능 호출이 402 insufficient_credits 를 반환하면 표시.
 *
 * - `error.meta.shortfall`(부족량) · required · available 을 소비한다(6.4).
 * - 활성 충전 상품 중 **부족량 이상 최소 상품**을 추천한다.
 * - `/credits` 이동 버튼 제공.
 * - hold 버퍼(×1.2) 때문에 표시 잔액보다 필요액이 커 보일 수 있음을
 *   "안전 여유분 포함" 문구로 설명한다(레드팀 규약).
 *
 * dialog 라이브러리를 추가하지 않고 자체 오버레이로 렌더한다(의존성 0 규약).
 *
 * @param meta 402 메타. null 이면 렌더하지 않음(닫힘).
 * @param onClose 닫기 콜백.
 */
export function InsufficientCreditsModal({
  meta,
  onClose,
}: {
  meta: InsufficientCreditsMeta | null;
  onClose: () => void;
}) {
  const [products, setProducts] = useState<CreditProductListDto["products"]>([]);

  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/web/credits/products");
        const result = (await res.json()) as ActionResult<CreditProductListDto>;
        if (!cancelled && result.ok && result.data) setProducts(result.data.products);
      } catch {
        // 상품 추천 실패는 조용히 무시 — /credits 이동 버튼으로 대체.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [meta]);

  // ESC 로 닫기.
  useEffect(() => {
    if (!meta) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [meta, onClose]);

  // 부족량 이상 최소 상품(totalCredits 기준). 없으면 가장 큰 상품.
  const recommended = useMemo(() => {
    if (!meta || products.length === 0) return null;
    const sorted = [...products].sort((a, b) => a.totalCredits - b.totalCredits);
    return sorted.find((p) => p.totalCredits >= meta.shortfall) ?? sorted[sorted.length - 1] ?? null;
  }, [meta, products]);

  if (!meta) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="insufficient-credits-title"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-[var(--radius-xl)] border bg-card p-6 text-card-foreground shadow-[var(--shadow-subtle)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600"
            aria-hidden="true"
          >
            <AlertTriangle className="size-5" />
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="닫기"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <h2 id="insufficient-credits-title" className="text-lg font-semibold text-foreground">
            크레딧이 부족합니다
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            이 작업을 완료하려면 <strong className="text-foreground">{meta.shortfall.toLocaleString("ko-KR")} 크레딧</strong>이
            더 필요합니다. 크레딧을 충전한 뒤 다시 시도해 주세요.
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2 rounded-[var(--radius-lg)] border bg-muted/40 p-3 text-center">
          <MetaCell label="필요" value={meta.required} tone="foreground" />
          <MetaCell label="보유(사용 가능)" value={meta.available} tone="foreground" />
          <MetaCell label="부족" value={meta.shortfall} tone="amber" />
        </dl>

        <p className="text-xs leading-5 text-muted-foreground">
          예상 사용량에는 <strong className="text-foreground">안전 여유분</strong>이 포함되어 있어, 표시된 잔액보다 필요액이
          크게 보일 수 있습니다. 실제 사용 후 남는 여유분은 차감되지 않습니다.
        </p>

        {recommended ? (
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border bg-background p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-medium text-muted-foreground">추천 충전</span>
              <strong className="truncate text-sm font-semibold text-foreground">
                {recommended.name} · {recommended.amountKrw.toLocaleString("ko-KR")}원
              </strong>
              <span className="text-xs text-muted-foreground">
                {recommended.totalCredits.toLocaleString("ko-KR")} 크레딧
                {recommended.bonusCredits > 0
                  ? ` (보너스 +${recommended.bonusCredits.toLocaleString("ko-KR")})`
                  : ""}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <a
            href={recommended ? `/credits?product=${encodeURIComponent(recommended.code)}` : "/credits"}
            className={buttonVariants({ className: "w-full sm:w-auto" })}
          >
            크레딧 충전하기
            <ArrowRight data-icon="inline-end" />
          </a>
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
            나중에
          </Button>
        </div>
      </div>
    </div>
  );
}

function MetaCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "foreground" | "amber";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === "amber"
            ? "text-sm font-semibold text-amber-600"
            : "text-sm font-semibold text-foreground"
        }
      >
        {value.toLocaleString("ko-KR")}
      </dd>
    </div>
  );
}
