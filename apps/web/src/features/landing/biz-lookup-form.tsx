"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useBizLookupController } from "./biz-lookup-context";
import { LookupSuggestions } from "./lookup-suggestions";

interface BizLookupFormProps {
  /** 입력 접근성 id(폼 인스턴스별 고유). */
  inputId: string;
  /** hero 폼만 true — dismiss 후 포커스가 이 입력으로 돌아온다. */
  attachRef?: boolean;
  ctaLabel?: string;
  className?: string;
  variant?: "hero" | "compact";
}

/**
 * 사업자번호 입력 → 조회 트리거 폼(상호작용 리프). 컨텍스트에서 컨트롤러를 구독한다.
 * InputGroup(shadcn) + 그라디언트 CTA Button으로 한 줄 조회 흐름을 만든다.
 */
export function BizLookupForm({
  inputId,
  attachRef = false,
  ctaLabel = "지원사업 찾기",
  className,
  variant = "hero",
}: BizLookupFormProps) {
  const controller = useBizLookupController();

  return (
    <form onSubmit={controller.submitBiz} className={cn("relative mx-auto w-full max-w-[620px]", className)}>
      <FieldGroup className="gap-0">
        <Field className="gap-0">
          <FieldLabel htmlFor={inputId} className="sr-only">
            사업자등록번호
          </FieldLabel>
          <InputGroup
            className={cn(
              "border-brand-tint bg-card pr-2.5 pl-4",
              variant === "compact"
                ? "h-16 rounded-2xl border-transparent shadow-[var(--shadow-landing-final-form)] sm:pl-[22px]"
                : "h-[68px] rounded-[18px] shadow-[var(--shadow-landing-form)] sm:pl-6",
            )}
          >
            <InputGroupInput
              id={inputId}
              ref={attachRef ? controller.heroInputRef : undefined}
              inputMode="numeric"
              maxLength={12}
              autoComplete="off"
              placeholder="000-00-00000"
              value={controller.biz}
              onChange={(event) => controller.onBizInput(event.target.value)}
              onFocus={(event) => controller.markActiveInput(event.currentTarget)}
              className={cn(
                "font-normal tracking-wide text-ink-strong tabular-nums",
                variant === "compact" ? "text-lg sm:text-[19px]" : "text-lg sm:text-xl",
              )}
            />
            <InputGroupAddon align="inline-end">
              <Button
                type="submit"
                disabled={controller.isSubmitting}
                className={cn(
                  "px-4 text-base sm:px-6",
                  variant === "compact"
                    ? "shadow-[var(--shadow-cta-final)]"
                    : "rounded-[13px] shadow-[var(--shadow-cta-hero)] sm:px-[26px]",
                )}
              >
                {controller.isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                {ctaLabel}
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </FieldGroup>
      <LookupSuggestions
        suggestions={controller.suggestions}
        deletingSuggestionIds={controller.deletingSuggestionIds}
        onSelect={controller.selectSuggestion}
        onDelete={controller.deleteSuggestion}
      />
    </form>
  );
}
