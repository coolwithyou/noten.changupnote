"use client";

import { Building2, ChevronRight, LoaderCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";

interface LookupSuggestionsProps {
  suggestions: BusinessLookupSuggestion[];
  deletingSuggestionIds: ReadonlySet<string>;
  onSelect: (suggestion: BusinessLookupSuggestion) => void;
  onDelete: (suggestion: BusinessLookupSuggestion) => void;
}

/**
 * 입력창 아래 최근 조회 제안 리스트. 클릭 시 해당 번호로 입력을 채운다.
 * 항목 선택과 조회 기록 삭제를 각각 독립 버튼으로 제공한다.
 * 단순 action 버튼 묶음이므로 listbox가 아닌 group으로 노출한다.
 */
export function LookupSuggestions({
  suggestions,
  deletingSuggestionIds,
  onSelect,
  onDelete,
}: LookupSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div role="group" aria-label="최근 조회한 사업자" className="mt-3 flex flex-col gap-2">
      {suggestions.map((suggestion) => (
        <div
          key={`${suggestion.source}:${suggestion.bizNo}`}
          className="flex w-full items-center gap-1 rounded-[12px] border border-input bg-card pr-2 shadow-[var(--shadow-subtle)] transition-colors hover:bg-surface-soft"
        >
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSelect(suggestion)}
            className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-[12px] px-3 py-2.5 text-left whitespace-normal hover:bg-transparent"
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={deletingSuggestionIds.has(suggestion.id)}
            aria-label={`${suggestion.companyName ?? suggestion.bizNoFormatted} 최근 조회 기록 삭제`}
            title="최근 조회 기록 삭제"
            onClick={() => onDelete(suggestion)}
            className="size-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            {deletingSuggestionIds.has(suggestion.id)
              ? <LoaderCircle className="size-4 animate-spin" />
              : <Trash2 className="size-4" />}
          </Button>
        </div>
      ))}
    </div>
  );
}
