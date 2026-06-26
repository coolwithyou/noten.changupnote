import type { GrantCriterion, MatchResult, NormalizedGrant } from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
} from "../bizinfo/extraction-input.js";
import {
  extractBizInfoCriteriaWithAnthropic,
  DEFAULT_ANTHROPIC_MODEL,
} from "../bizinfo/llm-criteria.js";
import { normalizeBizInfoProgram } from "../bizinfo/normalize.js";
import { fetchBizInfoPrograms } from "../bizinfo/fetch.js";
import type { BizInfoProgram } from "../bizinfo/types.js";
import { buildCompanyProfileFromPopbill } from "../company/profile-from-popbill.js";
import { fetchKStartupPage } from "../kstartup/fetch.js";
import { normalizeKStartupPayload } from "../kstartup/normalize.js";
import { maskCorpNum, checkPopbillBizInfo } from "../popbill/check-biz-info.js";
import type { PopbillCredentials } from "../popbill/types.js";
import { matchGrantCriteria } from "./match.js";

export interface LiveCompanyMatchOptions {
  kstartupServiceKey: string;
  bizinfoServiceKey: string;
  popbillCredentials: PopbillCredentials;
  checkCorpNum: string;
  anthropicApiKey?: string | null;
  anthropicModel?: string | null;
  kstartupLimit?: number;
  bizinfoLimit?: number;
  bizinfoLlm?: boolean;
}

export interface LiveCompanyMatchReport {
  company: {
    masked_biz_no: string;
    name: string | null;
    region: { code: string; label?: string } | null;
    biz_age_months: number | null;
    size: string | null;
    industries: string[];
    confidence: Record<string, number>;
    popbill: ReturnType<typeof buildCompanyProfileFromPopbill>["facts"];
  };
  kstartup: {
    fetched_count: number;
    total_count: number | string | null;
    normalized_count: number;
    match_counts: Record<string, number>;
    top_matches: MatchSummary[];
  };
  bizinfo: {
    fetched_count: number;
    evaluated_count: number;
    llm_enabled: boolean;
    llm_model: string | null;
    match_counts: Record<string, number>;
    top_matches: MatchSummary[];
    extraction_only: Array<{
      source_id: string;
      title: string;
      extraction_input_length: number;
      criteria_count: number;
    }>;
  };
  privacy_note: string;
}

export interface MatchSummary {
  source: string;
  source_id: string;
  title: string;
  status: string;
  criteria_count: number;
  eligibility: MatchResult["eligibility"];
  fit_score: number;
  unknown_fields: string[];
  next_question: string | null;
  trace: string[];
  extraction_input_length?: number;
  llm_usage?: Record<string, unknown> | null;
}

interface BizInfoMatchEntry {
  item: NormalizedGrant<BizInfoProgram>;
  match: MatchResult | null;
  extraction_input_length: number;
  llm_usage: Record<string, unknown> | null;
}

interface MatchedBizInfoEntry extends Omit<BizInfoMatchEntry, "match"> {
  match: MatchResult;
}

export async function runLiveCompanyMatch(
  options: LiveCompanyMatchOptions,
): Promise<LiveCompanyMatchReport> {
  const kstartupLimit = options.kstartupLimit ?? 10;
  const bizinfoLimit = options.bizinfoLimit ?? 1;
  const bizinfoLlm = (options.bizinfoLlm ?? true) && bizinfoLimit > 0;
  const anthropicModel = options.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL;

  const popbillInfo = await checkPopbillBizInfo({
    credentials: options.popbillCredentials,
    checkCorpNum: options.checkCorpNum,
  });
  if (String(popbillInfo.result) !== "100") {
    throw new Error(`Popbill checkBizInfo failed: ${popbillInfo.result ?? "unknown"} ${popbillInfo.resultMessage ?? ""}`);
  }
  const company = buildCompanyProfileFromPopbill(popbillInfo);

  const kstartupPayload = await fetchKStartupPage({
    serviceKey: options.kstartupServiceKey,
    page: 1,
    perPage: kstartupLimit,
  });
  const kstartupNormalized = normalizeKStartupPayload(kstartupPayload);
  const kstartupMatches = kstartupNormalized.map((item) => ({
    item,
    match: matchGrantCriteria(item.criteria, company.profile),
  }));

  const bizinfoPayload = bizinfoLimit > 0
    ? await fetchBizInfoPrograms({ serviceKey: options.bizinfoServiceKey })
    : { jsonArray: [] as BizInfoProgram[] };
  const bizinfoPrograms = bizinfoPayload.jsonArray.slice(0, bizinfoLimit);
  const bizinfoMatches: BizInfoMatchEntry[] = [];

  for (const program of bizinfoPrograms) {
    const input = buildBizInfoProgramExtractionInput(program);
    let criteria: GrantCriterion[] = [];
    let usage: Record<string, unknown> | null = null;
    if (bizinfoLlm) {
      if (!options.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required when bizinfo LLM extraction is enabled.");
      }
      const extracted = await extractBizInfoCriteriaWithAnthropic({
        input,
        apiKey: options.anthropicApiKey,
        model: anthropicModel,
      });
      criteria = extracted.criteria;
      usage = extracted.usage;
    }
    const normalized = normalizeBizInfoProgram(program, criteria, { model: bizinfoLlm ? anthropicModel : null });
    bizinfoMatches.push({
      item: normalized,
      match: criteria.length > 0 ? matchGrantCriteria(criteria, company.profile) : null,
      extraction_input_length: input.text.length,
      llm_usage: usage,
    });
  }
  const matchedBizinfo: MatchedBizInfoEntry[] = bizinfoMatches.flatMap((entry) =>
    entry.match ? [{ ...entry, match: entry.match }] : [],
  );

  return {
    company: {
      masked_biz_no: company.facts.masked_biz_no ?? maskCorpNum(options.checkCorpNum),
      name: company.profile.name ?? null,
      region: company.profile.region ?? null,
      biz_age_months: company.profile.biz_age_months ?? null,
      size: company.profile.size ?? null,
      industries: company.profile.industries ?? [],
      confidence: (company.profile.confidence ?? {}) as Record<string, number>,
      popbill: company.facts,
    },
    kstartup: {
      fetched_count: kstartupPayload.currentCount ?? kstartupPayload.data.length,
      total_count: kstartupPayload.totalCount ?? kstartupPayload.matchCount ?? null,
      normalized_count: kstartupNormalized.length,
      match_counts: countMatches(kstartupMatches.map((entry) => entry.match)),
      top_matches: summarizeMatches(kstartupMatches, 5),
    },
    bizinfo: {
      fetched_count: bizinfoPayload.jsonArray.length,
      evaluated_count: bizinfoMatches.length,
      llm_enabled: bizinfoLlm,
      llm_model: bizinfoLlm ? anthropicModel : null,
      match_counts: countMatches(matchedBizinfo.map((entry) => entry.match)),
      top_matches: summarizeMatches(matchedBizinfo, 5),
      extraction_only: bizinfoMatches.filter((entry) => !entry.match).map((entry) => ({
        source_id: entry.item.grant.source_id,
        title: entry.item.grant.title,
        extraction_input_length: entry.extraction_input_length,
        criteria_count: entry.item.criteria.length,
      })),
    },
    privacy_note: "사업자번호 원문, 대표자명, 상세주소는 출력하지 않습니다.",
  };
}

function summarizeMatches<TPayload>(
  entries: Array<{
    item: NormalizedGrant<TPayload>;
    match: MatchResult;
    extraction_input_length?: number;
    llm_usage?: Record<string, unknown> | null;
  }>,
  limit: number,
): MatchSummary[] {
  return [...entries]
    .sort((a, b) => compareMatch(a.match, b.match))
    .slice(0, limit)
    .map((entry) => {
      const summary: MatchSummary = {
        source: entry.item.grant.source,
        source_id: entry.item.grant.source_id,
        title: entry.item.grant.title,
        status: entry.item.grant.status,
        criteria_count: entry.item.criteria.length,
        eligibility: entry.match.eligibility,
        fit_score: entry.match.fit_score,
        unknown_fields: entry.match.unknown_fields,
        next_question: entry.match.next_question?.prompt ?? null,
        trace: entry.match.rule_trace.slice(0, 3).map((trace) => trace.message),
      };
      if (entry.extraction_input_length !== undefined) {
        summary.extraction_input_length = entry.extraction_input_length;
      }
      if (entry.llm_usage !== undefined) {
        summary.llm_usage = entry.llm_usage;
      }
      return summary;
    });
}

function countMatches(matches: MatchResult[]): Record<string, number> {
  return matches.reduce<Record<string, number>>((acc, match) => {
    acc[match.eligibility] = (acc[match.eligibility] ?? 0) + 1;
    return acc;
  }, {});
}

function compareMatch(a: MatchResult, b: MatchResult): number {
  const rank: Record<MatchResult["eligibility"], number> = {
    eligible: 0,
    conditional: 1,
    ineligible: 2,
  };
  return rank[a.eligibility] - rank[b.eligibility] || b.fit_score - a.fit_score;
}
