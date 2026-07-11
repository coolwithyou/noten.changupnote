"use client";

import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { useBizLookupController } from "./biz-lookup-context";
import { LookupSuggestions } from "./lookup-suggestions";

interface BizLookupFormProps {
  /** 입력 접근성 id(폼 인스턴스별 고유). */
  inputId: string;
  /** hero 폼만 true — dismiss 후 포커스가 이 입력으로 돌아온다. */
  attachRef?: boolean;
  ctaLabel?: string;
}

/**
 * 사업자번호 입력 → 조회 트리거 폼(상호작용 리프). 컨텍스트에서 컨트롤러를 구독한다.
 * InputGroup(shadcn) + 그라디언트 CTA Button, 입력창 뒤 glow-brand로 시선을 모은다.
 */
export function BizLookupForm({ inputId, attachRef = false, ctaLabel = "지원사업 찾기" }: BizLookupFormProps) {
  const controller = useBizLookupController();

  return (
    <form onSubmit={controller.submitBiz} className="relative mx-auto w-full max-w-xl">
      <div
        aria-hidden
        className="glow-brand pointer-events-none absolute -inset-x-6 -inset-y-10 -z-10 rounded-[2.5rem] blur-xl"
      />
      <InputGroup className="h-16 rounded-2xl border-input bg-card pr-2 pl-4 shadow-[var(--shadow-elevated)]">
        <InputGroupInput
          id={inputId}
          ref={attachRef ? controller.heroInputRef : undefined}
          aria-label="사업자등록번호"
          inputMode="numeric"
          maxLength={12}
          autoComplete="off"
          placeholder="000-00-00000"
          value={controller.biz}
          onChange={(event) => controller.onBizInput(event.target.value)}
          onFocus={(event) => controller.markActiveInput(event.currentTarget)}
          className="text-lg font-bold tracking-wide tabular-nums"
        />
        <InputGroupAddon align="inline-end">
          <Button type="submit" size="lg" disabled={controller.isSubmitting} className="bg-[image:var(--grad-cta)]">
            {controller.isSubmitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Search data-icon="inline-start" />
            )}
            {ctaLabel}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <LookupSuggestions suggestions={controller.suggestions} onSelect={controller.selectSuggestion} />
    </form>
  );
}
