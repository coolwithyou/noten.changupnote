import type { CompanyProfile, MatchCard } from "@cunote/contracts";
import { buildDashboard } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 100, 1, 500);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 2_000);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const db = getCunoteDb();

const profiles: Array<{ id: string; company: CompanyProfile }> = [
  {
    id: "software-seoul",
    company: {
      region: { code: "11", label: "서울" },
      industries: ["소프트웨어 개발", "정보서비스"],
      industry_codes: ["J62", "J63"],
      other_conditions: { interest_goals: ["R&D", "수출", "사업화"] },
    },
  },
  {
    id: "manufacturing-gyeonggi",
    company: {
      region: { code: "41", label: "경기" },
      industries: ["금속 가공제품 제조업"],
      industry_codes: ["C25"],
      other_conditions: { interest_goals: ["자금", "고용", "사업화"] },
    },
  },
  {
    id: "food-busan",
    company: {
      region: { code: "26", label: "부산" },
      industries: ["식료품 제조업", "음식점업"],
      industry_codes: ["C10", "I56"],
      other_conditions: { interest_goals: ["자금", "수출", "인증"] },
    },
  },
];

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const loadedGrants = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const grants = stratifiedGrantSample(loadedGrants, limit);
  const reports = profiles.map(({ id, company }) => {
    const dashboard = buildDashboard({ company, grants, asOf, limit: grants.length });
    return {
      profile: id,
      evaluated: dashboard.matches.length,
      relevance: scoreHistogram(dashboard.matches, "relevanceScore"),
      priority: scoreHistogram(dashboard.matches, "priorityScore"),
      top: dashboard.matches.slice(0, 5).map((match) => ({
        source: match.source,
        sourceId: match.sourceId,
        title: match.title,
        recommendationTier: match.recommendationTier,
        eligibility: match.eligibility,
        extractionReadiness: match.quality?.extractionReadiness,
        relevanceScore: match.ranking?.relevanceScore ?? null,
        priorityScore: match.ranking?.priorityScore ?? null,
        reasons: match.ranking?.reasons.slice(0, 3) ?? [],
      })),
    };
  });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    scanLimit,
    loadedGrantCount: loadedGrants.length,
    grantCount: grants.length,
    sourceCounts: histogram(grants.map((entry) => entry.grant.source)),
    writeMode: false,
    industrySignalCoverage: industrySignalCoverage(grants),
    profiles: reports,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function stratifiedGrantSample<T extends { grant: { source: string } }>(grants: T[], limit: number): T[] {
  const bySource = new Map<string, T[]>();
  for (const entry of grants) bySource.set(entry.grant.source, [...(bySource.get(entry.grant.source) ?? []), entry]);
  const sources = [...bySource.keys()].sort();
  const selected: T[] = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const source of sources) {
      const entry = bySource.get(source)?.[index];
      if (!entry) continue;
      selected.push(entry);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function industrySignalCoverage(
  grants: Array<{ grant: { source: string; f_industries: string[] }; criteria: Array<{ dimension: string; value: unknown }> }>,
) {
  const bySource: Record<string, { grants: number; fIndustries: number; industryCriteria: number; ksic: number }> = {};
  const labels = new Map<string, number>();
  const criterionValues = new Map<string, number>();
  const criterionValueKeys = new Map<string, number>();
  for (const entry of grants) {
    const bucket = bySource[entry.grant.source] ?? { grants: 0, fIndustries: 0, industryCriteria: 0, ksic: 0 };
    bucket.grants += 1;
    if (entry.grant.f_industries.length > 0) bucket.fIndustries += 1;
    if (entry.criteria.some((criterion) => criterion.dimension === "industry")) bucket.industryCriteria += 1;
    if (entry.grant.f_industries.some(isLikelyKsic)) bucket.ksic += 1;
    bySource[entry.grant.source] = bucket;
    for (const value of entry.grant.f_industries) labels.set(value, (labels.get(value) ?? 0) + 1);
    for (const criterion of entry.criteria.filter((item) => item.dimension === "industry")) {
      if (criterion.value && typeof criterion.value === "object" && !Array.isArray(criterion.value)) {
        for (const key of Object.keys(criterion.value as Record<string, unknown>)) {
          criterionValueKeys.set(key, (criterionValueKeys.get(key) ?? 0) + 1);
        }
      }
      for (const value of collectStrings(criterion.value)) {
        criterionValues.set(value, (criterionValues.get(value) ?? 0) + 1);
      }
    }
  }
  return {
    bySource,
    topLabels: [...labels.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))
      .slice(0, 15)
      .map(([label, count]) => ({ label, count })),
    topIndustryCriterionValues: [...criterionValues.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))
      .slice(0, 20)
      .map(([value, count]) => ({ value, count })),
    industryCriterionValueKeys: [...criterionValueKeys.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key, count]) => ({ key, count })),
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
}

function isLikelyKsic(value: string): boolean {
  return /^(?:[A-U](?:\d{2,5})?|\d{2,5})$/i.test(value.trim());
}

function scoreHistogram(matches: MatchCard[], field: "relevanceScore" | "priorityScore") {
  const histogram = { missing: 0, low: 0, medium: 0, high: 0 };
  for (const match of matches) {
    const value = match.ranking?.[field];
    if (value === null || value === undefined) histogram.missing += 1;
    else if (value >= 70) histogram.high += 1;
    else if (value >= 40) histogram.medium += 1;
    else histogram.low += 1;
  }
  return histogram;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
