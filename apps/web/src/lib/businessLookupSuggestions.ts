export type BusinessLookupSuggestionSource = "account" | "local";

export type BusinessLookupSuggestionCacheSource = "popbill_cache" | "saved_profile" | "client_storage";

export interface BusinessLookupSuggestion {
  id: string;
  bizNo: string;
  bizNoFormatted: string;
  bizNoMasked: string;
  companyName: string | null;
  industry: string | null;
  businessType: string | null;
  checkedAt: string | null;
  lastLookupAt: string | null;
  source: BusinessLookupSuggestionSource;
  cacheSource: BusinessLookupSuggestionCacheSource;
}

export interface BusinessLookupSuggestionsResult {
  authenticated: boolean;
  suggestions: BusinessLookupSuggestion[];
}

export interface BusinessLookupRecordResult {
  authenticated: boolean;
  recorded: boolean;
  suggestion: BusinessLookupSuggestion | null;
}

export interface BusinessLookupDeleteResult {
  authenticated: boolean;
  deleted: boolean;
}

export function formatBusinessLookupBizNo(value: string): string {
  const digits = normalizeBusinessLookupBizNo(value);
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function normalizeBusinessLookupBizNo(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}
