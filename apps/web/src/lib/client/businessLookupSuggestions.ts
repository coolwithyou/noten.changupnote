import type { ActionResult } from "@cunote/contracts";
import {
  formatBusinessLookupBizNo,
  normalizeBusinessLookupBizNo,
  type BusinessLookupRecordResult,
  type BusinessLookupSuggestion,
  type BusinessLookupSuggestionsResult,
} from "@/lib/businessLookupSuggestions";

const LOCAL_LOOKUP_SUGGESTIONS_STORAGE_KEY = "cunote.businessLookupSuggestions.v1";
export const MAX_LOOKUP_SUGGESTIONS = 6;

export async function fetchBusinessLookupSuggestions(): Promise<BusinessLookupSuggestionsResult | null> {
  try {
    const response = await fetch("/api/web/business-lookup-suggestions");
    const payload = await response.json() as ActionResult<BusinessLookupSuggestionsResult>;
    if (!response.ok || !payload.ok || !payload.data) return null;
    return payload.data;
  } catch {
    return null;
  }
}

export async function recordBusinessLookupSuggestion(bizNo: string): Promise<BusinessLookupRecordResult | null> {
  try {
    const response = await fetch("/api/web/business-lookup-suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bizNo }),
    });
    const payload = await response.json() as ActionResult<BusinessLookupRecordResult>;
    if (!response.ok || !payload.ok || !payload.data) return null;
    return payload.data;
  } catch {
    return null;
  }
}

export function readLocalBusinessLookupSuggestions(): BusinessLookupSuggestion[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_LOOKUP_SUGGESTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredBusinessLookupSuggestion)
      .filter((item): item is BusinessLookupSuggestion => Boolean(item))
      .slice(0, MAX_LOOKUP_SUGGESTIONS);
  } catch {
    return [];
  }
}

export function writeLocalBusinessLookupSuggestions(suggestions: BusinessLookupSuggestion[]) {
  try {
    window.localStorage.setItem(
      LOCAL_LOOKUP_SUGGESTIONS_STORAGE_KEY,
      JSON.stringify(suggestions.slice(0, MAX_LOOKUP_SUGGESTIONS)),
    );
  } catch {
    // Storage can be unavailable in private contexts; the current lookup still works.
  }
}

export function upsertBusinessLookupSuggestion(
  suggestions: BusinessLookupSuggestion[],
  suggestion: BusinessLookupSuggestion,
): BusinessLookupSuggestion[] {
  return [
    suggestion,
    ...suggestions.filter((item) => item.bizNo !== suggestion.bizNo),
  ].slice(0, MAX_LOOKUP_SUGGESTIONS);
}

function normalizeStoredBusinessLookupSuggestion(value: unknown): BusinessLookupSuggestion | null {
  if (!isRecord(value) || typeof value.bizNo !== "string") return null;
  const bizNo = normalizeBusinessLookupBizNo(value.bizNo);
  if (bizNo.length !== 10) return null;
  return {
    id: `local:${bizNo}`,
    bizNo,
    bizNoFormatted: formatBusinessLookupBizNo(bizNo),
    bizNoMasked: nullableText(value.bizNoMasked) ?? "**********",
    companyName: nullableText(value.companyName),
    industry: nullableText(value.industry),
    businessType: nullableText(value.businessType),
    checkedAt: nullableText(value.checkedAt),
    lastLookupAt: nullableText(value.lastLookupAt),
    source: "local",
    cacheSource: "client_storage",
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
