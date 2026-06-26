import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GrantCriterion, MatchResult, NormalizedGrant } from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
  buildCompanyProfileFromPopbill,
  checkPopbillBizInfo,
  DEFAULT_ANTHROPIC_MODEL,
  extractBizInfoCriteriaWithAnthropic,
  fetchBizInfoPrograms,
  fetchKStartupPage,
  maskCorpNum,
  matchGrantCriteria,
  normalizeBizInfoProgram,
  normalizeKStartupPayload,
  readPopbillEnvConfig,
  sanitizeCorpNum,
} from "../src/index.js";
import type { BizInfoProgram } from "../src/index.js";

interface BizInfoMatchEntry {
  item: NormalizedGrant<BizInfoProgram>;
  match: MatchResult | null;
  extraction_input_length: number;
  llm_usage: Record<string, unknown> | null;
}

interface MatchedBizInfoEntry extends Omit<BizInfoMatchEntry, "match"> {
  match: MatchResult;
}

loadDotEnv();

const kstartupKey = requiredEnv("KSTARTUP_SERVICE_KEY");
const bizinfoKey = requiredEnv("BIZINFO_SERVICE_KEY");
const popbill = readPopbillEnvConfig();
const overrideBizNo = readArg("bizNo");
const checkCorpNum = overrideBizNo ? sanitizeCorpNum(overrideBizNo) : popbill.checkCorpNum;
const kstartupLimit = readPositiveIntArg("kstartupLimit", 10, 1, 100);
const bizinfoLimit = readPositiveIntArg("bizinfoLimit", 1, 0, 20);
const bizinfoLlm = readArg("bizinfoLlm") !== "false" && bizinfoLimit > 0;
const anthropicKey = bizinfoLlm ? requiredEnv("ANTHROPIC_API_KEY") : null;
const anthropicModel = readArg("anthropicModel") ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

const popbillInfo = await checkPopbillBizInfo({
  credentials: popbill.credentials,
  checkCorpNum,
});
if (String(popbillInfo.result) !== "100") {
  throw new Error(`Popbill checkBizInfo failed: ${popbillInfo.result ?? "unknown"} ${popbillInfo.resultMessage ?? ""}`);
}
const company = buildCompanyProfileFromPopbill(popbillInfo);

const kstartupPayload = await fetchKStartupPage({
  serviceKey: kstartupKey,
  page: 1,
  perPage: kstartupLimit,
});
const kstartupNormalized = normalizeKStartupPayload(kstartupPayload);
const kstartupMatches = kstartupNormalized.map((item) => ({
  item,
  match: matchGrantCriteria(item.criteria, company.profile),
}));

const bizinfoPayload = bizinfoLimit > 0
  ? await fetchBizInfoPrograms({ serviceKey: bizinfoKey })
  : { jsonArray: [] as BizInfoProgram[] };
const bizinfoPrograms = bizinfoPayload.jsonArray.slice(0, bizinfoLimit);
const bizinfoMatches: BizInfoMatchEntry[] = [];

for (const program of bizinfoPrograms) {
  const input = buildBizInfoProgramExtractionInput(program);
  let criteria: GrantCriterion[] = [];
  let usage: Record<string, unknown> | null = null;
  if (bizinfoLlm && anthropicKey) {
    const extracted = await extractBizInfoCriteriaWithAnthropic({
      input,
      apiKey: anthropicKey,
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

console.log(JSON.stringify({
  company: {
    masked_biz_no: company.facts.masked_biz_no ?? maskCorpNum(checkCorpNum),
    name: company.profile.name ?? null,
    region: company.profile.region ?? null,
    biz_age_months: company.profile.biz_age_months ?? null,
    size: company.profile.size ?? null,
    industries: company.profile.industries ?? [],
    confidence: company.profile.confidence ?? {},
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
}, null, 2));

function summarizeMatches<TPayload>(
  entries: Array<{
    item: NormalizedGrant<TPayload>;
    match: MatchResult;
    extraction_input_length?: number;
    llm_usage?: Record<string, unknown> | null;
  }>,
  limit: number,
) {
  return [...entries]
    .sort((a, b) => compareMatch(a.match, b.match))
    .slice(0, limit)
    .map((entry) => ({
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
      extraction_input_length: entry.extraction_input_length,
      llm_usage: entry.llm_usage,
    }));
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

function loadDotEnv(path = ".env") {
  try {
    const body = readFileSync(resolve(path), "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      if (!rawKey) continue;
      const key = rawKey.trim();
      if (process.env[key] !== undefined) continue;
      let value = rest.join("=").trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // .env is optional in CI.
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env key: ${name}`);
  return value;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readPositiveIntArg(name: string, fallback: number, min: number, max: number): number {
  const raw = readArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid --${name}: ${raw ?? fallback}. Use ${min}..${max}.`);
  }
  return value;
}
