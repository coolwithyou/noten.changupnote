import type { BusinessLookupSuggestion } from "@/lib/businessLookupSuggestions";

export type ResolvedBusinessLookupDisplay = {
  companyName: string | null;
  industry: string | null;
  checkedAt: string | null;
};

/** 팝빌 단일 행에 비어 있는 표시 필드를 제품 프로필의 합성 캐시 결과로 보강한다. */
export function mergeBusinessLookupSuggestionDisplay(
  suggestion: BusinessLookupSuggestion,
  resolved: ResolvedBusinessLookupDisplay,
): BusinessLookupSuggestion {
  const companyName = suggestion.companyName ?? resolved.companyName;
  const industry = suggestion.industry ?? resolved.industry;
  const checkedAt = suggestion.checkedAt ?? resolved.checkedAt;
  const enriched = companyName !== suggestion.companyName || industry !== suggestion.industry;
  return {
    ...suggestion,
    companyName,
    industry,
    checkedAt,
    cacheSource: enriched ? "product_profile_cache" : suggestion.cacheSource,
  };
}
