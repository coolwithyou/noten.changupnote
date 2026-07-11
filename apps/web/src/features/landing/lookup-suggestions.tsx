"use client";

import { Building2, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";

interface LookupSuggestionsProps {
  suggestions: BusinessLookupSuggestion[];
  onSelect: (suggestion: BusinessLookupSuggestion) => void;
}

/**
 * 입력창 아래 최근 조회 제안 리스트. 클릭 시 해당 번호로 입력을 채운다.
 * 밝은 카드형 Button으로 통일 — 브랜드 밴드 위에서도 흰 표면으로 또렷하게 읽힌다.
 * 클릭 즉시 입력을 채우는 버튼 목록이므로 listbox가 아닌 단순 group으로 노출한다.
 */
export function LookupSuggestions({ suggestions, onSelect }: LookupSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div role="group" aria-label="최근 조회한 사업자" className="mt-3 flex flex-col gap-2">
      {suggestions.map((suggestion) => (
        <Button
          key={`${suggestion.source}:${suggestion.bizNo}`}
          type="button"
          variant="outline"
          onClick={() => onSelect(suggestion)}
          className="h-auto w-full justify-start gap-3 bg-card px-3 py-2.5 text-left whitespace-normal shadow-[var(--shadow-subtle)]"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent text-accent-foreground">
            <Building2 className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {suggestion.companyName ?? "상호 미확인"}
            </span>
            <span className="truncate text-xs font-medium text-muted-foreground tabular-nums">
              {suggestion.bizNoFormatted}
              {suggestion.industry ? ` · ${suggestion.industry}` : ""}
            </span>
          </span>
          <Badge variant="outline" className="shrink-0">
            {suggestion.source === "account" ? "내 계정" : "이 브라우저"}
          </Badge>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      ))}
    </div>
  );
}
