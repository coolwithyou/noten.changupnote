import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { CompanyProfile } from "@cunote/contracts";
import { isLikelyKsicCode, ksicDivisionLabel, ksicSectionLabel } from "@cunote/core/company/profile-from-popbill";
import { maskCorpNum, sanitizeCorpNum } from "@cunote/core/popbill/check-biz-info";
import {
  formatBusinessLookupBizNo,
  type BusinessLookupDeleteResult,
  type BusinessLookupRecordResult,
  type BusinessLookupSuggestion,
  type BusinessLookupSuggestionSource,
  type BusinessLookupSuggestionsResult,
} from "@/lib/businessLookupSuggestions";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { getCunoteDb, withCunoteDbUser, type CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { getRepositoryAdapterName } from "@/lib/server/repositories/factory";
import { resolveAnonymousProductCompanyProfile } from "@/lib/server/serviceData";
import {
  mergeBusinessLookupSuggestionDisplay,
  type ResolvedBusinessLookupDisplay,
} from "./businessLookupSuggestionDisplay";

const POPBILL_CACHE_PROVIDER = "popbill";
const POPBILL_CACHE_SCOPE = "checkBizInfo";
const MAX_ACCOUNT_SUGGESTIONS = 8;

type CacheRow = typeof schema.companyEnrichmentCache.$inferSelect;
type CompanyRow = typeof schema.companies.$inferSelect;
type ProfileRow = typeof schema.companyProfiles.$inferSelect;
type LookupHistoryRow = typeof schema.userBusinessLookupHistory.$inferSelect;
type UserCompanyLookupRow = { bizNo: string | null };

export async function listBusinessLookupSuggestionsForSession(): Promise<BusinessLookupSuggestionsResult> {
  const session = await getOptionalWebSession();
  if (!session) {
    return {
      authenticated: false,
      suggestions: [],
    };
  }

  const db = getDrizzleDbOrNull();
  if (!db) {
    return {
      authenticated: true,
      suggestions: [],
    };
  }

  const [historyRows, companyRows, dismissedRows] = await Promise.all([
    readLookupHistoryRows(db, session.user.id),
    readUserCompanyLookupRows(db, session.user.id),
    readDismissedLookupRows(db, session.user.id),
  ]);

  const dismissedBizNos = new Set(dismissedRows.map((row) => row.bizNo));

  const lastLookupByBizNo = new Map<string, string | null>();
  for (const row of historyRows) {
    lastLookupByBizNo.set(row.bizNo, row.lastLookedUpAt.toISOString());
  }

  const orderedBizNos = uniqueBizNos([
    ...historyRows.map((row) => row.bizNo),
    ...companyRows.flatMap((row) => row.bizNo && !dismissedBizNos.has(row.bizNo) ? [row.bizNo] : []),
  ]).slice(0, MAX_ACCOUNT_SUGGESTIONS);

  const suggestions = await Promise.all(
    orderedBizNos.map((bizNo) => buildBusinessLookupSuggestionSafely(db, {
      bizNo,
      source: "account",
      lastLookupAt: lastLookupByBizNo.get(bizNo) ?? null,
    })),
  );

  return {
    authenticated: true,
    suggestions: suggestions.filter((suggestion): suggestion is BusinessLookupSuggestion => Boolean(suggestion)),
  };
}

export async function recordBusinessLookupForSession(bizNoInput: string): Promise<BusinessLookupRecordResult> {
  const bizNo = sanitizeCorpNum(bizNoInput);
  const session = await getOptionalWebSession();
  const db = getDrizzleDbOrNull();
  const now = new Date();
  const source: BusinessLookupSuggestionSource = session ? "account" : "local";
  const suggestion = db
    ? await buildBusinessLookupSuggestionSafely(db, {
      bizNo,
      source,
      lastLookupAt: now.toISOString(),
    })
    : null;

  let recorded = false;
  if (session && db) {
    try {
      await withCunoteDbUser(db, session.user.id, async (tx) => {
        await tx
          .insert(schema.userBusinessLookupHistory)
          .values({
            userId: session.user.id,
            bizNo,
            firstLookedUpAt: now,
            lastLookedUpAt: now,
            lookupCount: 1,
          })
          .onConflictDoUpdate({
            target: [
              schema.userBusinessLookupHistory.userId,
              schema.userBusinessLookupHistory.bizNo,
            ],
            set: {
              lastLookedUpAt: now,
              lookupCount: sql`${schema.userBusinessLookupHistory.lookupCount} + 1`,
              dismissedAt: null,
            },
          });
      });
      recorded = true;
    } catch (error) {
      console.warn(`Business lookup history write failed: ${errorMessage(error)}`);
    }
  }

  return {
    authenticated: Boolean(session),
    recorded,
    suggestion,
  };
}

export async function deleteBusinessLookupForSession(bizNoInput: string): Promise<BusinessLookupDeleteResult> {
  const bizNo = sanitizeCorpNum(bizNoInput);
  const session = await getOptionalWebSession();
  const db = getDrizzleDbOrNull();
  if (!session || !db) {
    return {
      authenticated: Boolean(session),
      deleted: false,
    };
  }

  const now = new Date();
  try {
    await withCunoteDbUser(db, session.user.id, async (tx) => {
      await tx
        .insert(schema.userBusinessLookupHistory)
        .values({
          userId: session.user.id,
          bizNo,
          firstLookedUpAt: now,
          lastLookedUpAt: now,
          lookupCount: 0,
          dismissedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.userBusinessLookupHistory.userId,
            schema.userBusinessLookupHistory.bizNo,
          ],
          set: {
            dismissedAt: now,
          },
        });
    });
    return {
      authenticated: true,
      deleted: true,
    };
  } catch (error) {
    console.warn(`Business lookup history delete failed: ${errorMessage(error)}`);
    return {
      authenticated: true,
      deleted: false,
    };
  }
}

function getDrizzleDbOrNull(): CunoteDb | null {
  return getRepositoryAdapterName() === "drizzle" ? getCunoteDb() : null;
}

async function readLookupHistoryRows(db: CunoteDb, userId: string): Promise<LookupHistoryRow[]> {
  try {
    return await withCunoteDbUser(db, userId, async (tx) => tx
      .select()
      .from(schema.userBusinessLookupHistory)
      .where(and(
        eq(schema.userBusinessLookupHistory.userId, userId),
        isNull(schema.userBusinessLookupHistory.dismissedAt),
      ))
      .orderBy(desc(schema.userBusinessLookupHistory.lastLookedUpAt))
      .limit(MAX_ACCOUNT_SUGGESTIONS));
  } catch (error) {
    console.warn(`Business lookup history read failed: ${errorMessage(error)}`);
    return [];
  }
}

async function readDismissedLookupRows(db: CunoteDb, userId: string): Promise<Array<{ bizNo: string }>> {
  try {
    return await withCunoteDbUser(db, userId, async (tx) => tx
      .select({ bizNo: schema.userBusinessLookupHistory.bizNo })
      .from(schema.userBusinessLookupHistory)
      .where(and(
        eq(schema.userBusinessLookupHistory.userId, userId),
        isNotNull(schema.userBusinessLookupHistory.dismissedAt),
      )));
  } catch (error) {
    console.warn(`Dismissed business lookup history read failed: ${errorMessage(error)}`);
    return [];
  }
}

async function readUserCompanyLookupRows(db: CunoteDb, userId: string): Promise<UserCompanyLookupRow[]> {
  try {
    return await withCunoteDbUser(db, userId, async (tx) => tx
      .select({
        bizNo: schema.companies.bizNo,
      })
      .from(schema.userCompany)
      .innerJoin(schema.companies, eq(schema.userCompany.companyId, schema.companies.id))
      .where(eq(schema.userCompany.userId, userId)));
  } catch (error) {
    console.warn(`Business lookup company fallback read failed: ${errorMessage(error)}`);
    return [];
  }
}

async function buildBusinessLookupSuggestionSafely(
  db: CunoteDb,
  input: {
    bizNo: string;
    source: BusinessLookupSuggestionSource;
    lastLookupAt: string | null;
  },
): Promise<BusinessLookupSuggestion | null> {
  try {
    return await buildBusinessLookupSuggestion(db, input);
  } catch (error) {
    console.warn(`Business lookup suggestion cache read failed: ${errorMessage(error)}`);
    return null;
  }
}

async function buildBusinessLookupSuggestion(
  db: CunoteDb,
  input: {
    bizNo: string;
    source: BusinessLookupSuggestionSource;
    lastLookupAt: string | null;
  },
): Promise<BusinessLookupSuggestion | null> {
  const cached = await getCachedBusinessLookup(db, input.bizNo);
  if (cached) {
    return enrichSuggestionFromProductProfileIfNeeded(
      suggestionFromCacheRow(cached, input),
      input.bizNo,
    );
  }
  const saved = await getSavedCompanyBusinessLookup(db, input.bizNo);
  if (saved) {
    return enrichSuggestionFromProductProfileIfNeeded(
      suggestionFromSavedCompany(saved, input),
      input.bizNo,
    );
  }
  const resolved = await resolveBusinessLookupDisplay(input.bizNo);
  return resolved ? suggestionFromResolvedProfile(resolved, input) : null;
}

async function enrichSuggestionFromProductProfileIfNeeded(
  suggestion: BusinessLookupSuggestion,
  bizNo: string,
): Promise<BusinessLookupSuggestion> {
  if (suggestion.companyName && suggestion.industry) return suggestion;
  const resolved = await resolveBusinessLookupDisplay(bizNo);
  return resolved ? mergeBusinessLookupSuggestionDisplay(suggestion, resolved) : suggestion;
}

async function resolveBusinessLookupDisplay(bizNo: string): Promise<ResolvedBusinessLookupDisplay | null> {
  try {
    const resolution = await resolveAnonymousProductCompanyProfile({ bizNo }, { asOf: new Date() });
    const profile = resolution.profile;
    const checkedAt = resolution.view.rows
      .flatMap((row) => row.asOf ? [row.asOf] : [])
      .sort()
      .at(-1) ?? null;
    return {
      companyName: firstString(profile.name),
      industry: resolveIndustryLabel(null, stringArray(profile.industries), stringArray(profile.industry_codes)),
      checkedAt,
    };
  } catch {
    // 최근 조회 목록은 보조 UI이므로 합성 프로필을 읽지 못해도 기존 팝빌/저장 회사 표시를 유지한다.
    return null;
  }
}

async function getCachedBusinessLookup(db: CunoteDb, bizNo: string): Promise<CacheRow | null> {
  const [row] = await db
    .select()
    .from(schema.companyEnrichmentCache)
    .where(and(
      eq(schema.companyEnrichmentCache.provider, POPBILL_CACHE_PROVIDER),
      eq(schema.companyEnrichmentCache.scope, POPBILL_CACHE_SCOPE),
      eq(schema.companyEnrichmentCache.bizNo, bizNo),
    ))
    .limit(1);
  return row ?? null;
}

async function getSavedCompanyBusinessLookup(
  db: CunoteDb,
  bizNo: string,
): Promise<{ company: CompanyRow; profileRows: ProfileRow[] } | null> {
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.bizNo, bizNo))
    .limit(1);
  if (!company) return null;

  const profileRows = await db
    .select()
    .from(schema.companyProfiles)
    .where(eq(schema.companyProfiles.companyId, company.id));

  return { company, profileRows };
}

function suggestionFromCacheRow(
  row: CacheRow,
  input: {
    bizNo: string;
    source: BusinessLookupSuggestionSource;
    lastLookupAt: string | null;
  },
): BusinessLookupSuggestion {
  const raw = isRecord(row.rawPayload) ? row.rawPayload : {};
  const canonical = isRecord(row.canonicalPayload) ? row.canonicalPayload : {};
  const profile = isRecord(canonical.profile) ? canonical.profile as CompanyProfile : {};
  const facts = isRecord(canonical.facts) ? canonical.facts : {};
  const rawBizNo = firstString(raw.corpNum, input.bizNo) ?? input.bizNo;
  const bizNo = sanitizeCorpNum(rawBizNo);
  const businessType = firstString(raw.bizClass);
  const rawIndustry = firstString(raw.bizType);
  const profileIndustries = stringArray(profile.industries);
  const industry = resolveIndustryLabel(rawIndustry, profileIndustries, stringArray(profile.industry_codes));

  return {
    id: `${input.source}:${bizNo}`,
    bizNo,
    bizNoFormatted: formatBusinessLookupBizNo(bizNo),
    bizNoMasked: maskBizNoSafely(bizNo),
    companyName: firstString(raw.corpName, profile.name),
    industry,
    businessType,
    checkedAt: row.checkedAt?.toISOString() ?? firstString(facts.checkedAt),
    lastLookupAt: input.lastLookupAt,
    source: input.source,
    cacheSource: "popbill_cache",
  };
}

function suggestionFromSavedCompany(
  saved: { company: CompanyRow; profileRows: ProfileRow[] },
  input: {
    bizNo: string;
    source: BusinessLookupSuggestionSource;
    lastLookupAt: string | null;
  },
): BusinessLookupSuggestion {
  const profileIndustry = saved.profileRows
    .filter((row) => row.dimension === "industry")
    .flatMap((row) => stringArray(row.value.industries ?? row.value.tags ?? row.value.policy_tags))
    .slice(0, 2)
    .join(", ");

  return {
    id: `${input.source}:${input.bizNo}`,
    bizNo: input.bizNo,
    bizNoFormatted: formatBusinessLookupBizNo(input.bizNo),
    bizNoMasked: maskBizNoSafely(input.bizNo),
    companyName: saved.company.name,
    industry: profileIndustry || null,
    businessType: null,
    checkedAt: saved.company.verifiedAt?.toISOString() ?? null,
    lastLookupAt: input.lastLookupAt,
    source: input.source,
    cacheSource: "saved_profile",
  };
}

function suggestionFromResolvedProfile(
  resolved: ResolvedBusinessLookupDisplay,
  input: {
    bizNo: string;
    source: BusinessLookupSuggestionSource;
    lastLookupAt: string | null;
  },
): BusinessLookupSuggestion {
  return {
    id: `${input.source}:${input.bizNo}`,
    bizNo: input.bizNo,
    bizNoFormatted: formatBusinessLookupBizNo(input.bizNo),
    bizNoMasked: maskBizNoSafely(input.bizNo),
    companyName: resolved.companyName,
    industry: resolved.industry,
    businessType: null,
    checkedAt: resolved.checkedAt,
    lastLookupAt: input.lastLookupAt,
    source: input.source,
    cacheSource: "product_profile_cache",
  };
}

function resolveIndustryLabel(
  rawIndustry: string | null,
  profileIndustries: string[],
  profileIndustryCodes: string[],
): string | null {
  const labels = [
    ...splitIndustryText(rawIndustry),
    ...profileIndustries,
  ].filter((item) => !isLikelyKsicCode(item));
  if (labels.length > 0) return uniqueTexts(labels).slice(0, 2).join(", ");

  const derived = [
    ...splitIndustryText(rawIndustry),
    ...profileIndustries,
    ...profileIndustryCodes,
  ].flatMap((code) => [ksicDivisionLabel(code), ksicSectionLabel(code)])
    .find((label): label is string => Boolean(label));
  if (derived) return derived;

  return rawIndustry ?? (profileIndustries.length > 0 ? profileIndustries.slice(0, 2).join(", ") : null);
}

function splitIndustryText(value: string | null): string[] {
  if (!value) return [];
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => firstString(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueBizNos(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    try {
      const bizNo = sanitizeCorpNum(value);
      if (seen.has(bizNo)) continue;
      seen.add(bizNo);
      result.push(bizNo);
    } catch {
      // Ignore legacy malformed values.
    }
  }
  return result;
}

function uniqueTexts(values: string[]): string[] {
  return [...new Set(values)];
}

function maskBizNoSafely(value: string): string {
  try {
    return maskCorpNum(value);
  } catch {
    return "**********";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
