import type {
  CompanyProfile,
  CriterionDimension,
  Eligibility,
  GrantSource,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  measureAutofillCoverage,
  type AutofillCoverageMetrics,
  type AutofillCoverageRow,
  type AutofillGrantWeights,
} from "../autofill/coverage.js";
import { matchNormalizedGrant } from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import type { MatchedGrant } from "../use-cases/match-card.js";

export type BusinessKind = "individual" | "corporation";

export interface BusinessNumberCompanyFixture {
  companyId: string;
  businessKind: BusinessKind;
  profile: CompanyProfile;
}

export interface BusinessNumberCompanyReadiness {
  companyId: string;
  businessKind: BusinessKind;
  initialEligibilityCounts: Record<Eligibility, number>;
  fullEligibilityCounts: Record<Eligibility, number>;
  immediateDeterminateRate: number;
  initialRecommendableCount: number;
  initialRecommendableRate: number;
  hardConditionKnownRate: number;
  falseIneligibleAgainstFullCount: number;
  unsafeIneligibleAgainstFullViableCount: number;
  firstQuestionDimension: CriterionDimension | null;
  firstQuestionAffectedGrantCount: number;
  firstQuestionResolvesGrantCount: number;
}

export interface BusinessNumberAggregate {
  pairCount: number;
  initialEligibilityCounts: Record<Eligibility, number>;
  immediateDeterminateRate: number;
  initialRecommendableCount: number;
  initialRecommendableRate: number;
  hardConditionKnownRate: number;
  falseIneligibleAgainstFullCount: number;
  unsafeIneligibleAgainstFullViableCount: number;
  hardUnknownDimensionCounts: Partial<Record<CriterionDimension, number>>;
  extractionReadinessCounts: Record<MatchExtractionReadiness, number>;
  recommendableByExtractionReadiness: Record<MatchExtractionReadiness, number>;
}

export interface BusinessNumberFirstResultReport extends BusinessNumberAggregate {
  projectionVersion: string;
  companyCount: number;
  grantCount: number;
  fullEligibilityCounts: Record<Eligibility, number>;
  autofillCoverage: AutofillCoverageMetrics;
  firstQuestionDimensionCounts: Partial<Record<CriterionDimension, number>>;
  byBusinessKind: Record<BusinessKind, BusinessNumberAggregate>;
  bySource: Partial<Record<GrantSource, BusinessNumberAggregate>>;
  companies: BusinessNumberCompanyReadiness[];
}

export const BUSINESS_NUMBER_INITIAL_PROJECTION_VERSION = "business-number-current-implemented-v2";

/** 현재 구현된 Popbill/NTS 기본 경로와 사업자 유형 파생값만 보수적으로 남긴다. */
export function projectBusinessNumberInitialProfile(
  profile: CompanyProfile,
  businessKind: BusinessKind,
): CompanyProfile {
  const projected: CompanyProfile = {
    is_preliminary: false,
    confidence: {},
    list_completeness: {},
  };
  if (profile.id) projected.id = profile.id;
  if (profile.name) projected.name = profile.name;
  if (profile.region) {
    projected.region = { ...profile.region };
    projected.confidence!.region = 0.8;
  }
  if (typeof profile.biz_age_months === "number") {
    projected.biz_age_months = profile.biz_age_months;
    projected.confidence!.biz_age = 0.75;
  }
  if (profile.industries?.length || profile.industry_codes?.length) {
    projected.industries = [...(profile.industries ?? [])];
    projected.industry_codes = [...(profile.industry_codes ?? [])];
    projected.confidence!.industry = profile.industry_codes?.length ? 0.7 : 0.6;
    projected.list_completeness!.industry = "partial";
  }
  if (profile.size) {
    projected.size = profile.size;
    projected.confidence!.size = 0.65;
  }
  if (profile.business_status?.active !== undefined) {
    projected.business_status = { ...profile.business_status };
    projected.confidence!.business_status = 0.9;
  }
  projected.target_types = [businessKind === "individual" ? "개인사업자" : "법인사업자"];
  projected.confidence!.target_type = 1;
  // 사업자 유형은 exact지만 target_type 축 전체(창업기업·특정 대상 등)는 소진하지 않는다.
  projected.list_completeness!.target_type = "partial";
  return projected;
}

export function buildBusinessNumberFirstResultReport<TPayload>(input: {
  companies: BusinessNumberCompanyFixture[];
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
}): BusinessNumberFirstResultReport {
  const asOf = input.asOf ?? new Date();
  const companyReports: BusinessNumberCompanyReadiness[] = [];
  const pairs: PairObservation[] = [];

  for (const company of input.companies) {
    const initialProfile = projectBusinessNumberInitialProfile(company.profile, company.businessKind);
    const initialMatched: Array<MatchedGrant<TPayload>> = [];
    const companyPairs: PairObservation[] = [];
    for (const grant of input.grants) {
      const initial = matchNormalizedGrant(grant, initialProfile);
      const full = matchNormalizedGrant(grant, company.profile);
      const observation: PairObservation = { businessKind: company.businessKind, source: grant.grant.source, initial, full };
      pairs.push(observation);
      companyPairs.push(observation);
      initialMatched.push({ item: grant, match: initial });
    }
    const question = planProfileQuestions(initialMatched, { asOf, limit: 1 })[0];
    const summary = aggregate(companyPairs);
    companyReports.push({
      companyId: company.companyId,
      businessKind: company.businessKind,
      initialEligibilityCounts: summary.initialEligibilityCounts,
      fullEligibilityCounts: eligibilityCounts(companyPairs.map((pair) => pair.full.eligibility)),
      immediateDeterminateRate: summary.immediateDeterminateRate,
      initialRecommendableCount: summary.initialRecommendableCount,
      initialRecommendableRate: summary.initialRecommendableRate,
      hardConditionKnownRate: summary.hardConditionKnownRate,
      falseIneligibleAgainstFullCount: summary.falseIneligibleAgainstFullCount,
      unsafeIneligibleAgainstFullViableCount: summary.unsafeIneligibleAgainstFullViableCount,
      firstQuestionDimension: question?.question.dimension ?? null,
      firstQuestionAffectedGrantCount: question?.question.affectedGrantCount ?? 0,
      firstQuestionResolvesGrantCount: question?.resolvesGrantCount ?? 0,
    });
  }

  const grantWeights = hardCriterionWeights(input.grants);
  const coverageRows = input.companies.flatMap((company) =>
    initialCoverageRows(projectBusinessNumberInitialProfile(company.profile, company.businessKind)));
  return {
    projectionVersion: BUSINESS_NUMBER_INITIAL_PROJECTION_VERSION,
    companyCount: input.companies.length,
    grantCount: input.grants.length,
    ...aggregate(pairs),
    fullEligibilityCounts: eligibilityCounts(pairs.map((pair) => pair.full.eligibility)),
    autofillCoverage: measureAutofillCoverage(mergeCoverageRows(coverageRows, input.companies.length), grantWeights),
    firstQuestionDimensionCounts: histogramDimensions(companyReports.flatMap((company) =>
      company.firstQuestionDimension ? [company.firstQuestionDimension] : [])),
    byBusinessKind: {
      individual: aggregate(pairs.filter((pair) => pair.businessKind === "individual")),
      corporation: aggregate(pairs.filter((pair) => pair.businessKind === "corporation")),
    },
    bySource: Object.fromEntries([...new Set(pairs.map((pair) => pair.source))].map((source) => [
      source,
      aggregate(pairs.filter((pair) => pair.source === source)),
    ])),
    companies: companyReports,
  };
}

interface PairObservation {
  businessKind: BusinessKind;
  source: GrantSource;
  initial: ReturnType<typeof matchNormalizedGrant>;
  full: ReturnType<typeof matchNormalizedGrant>;
}

function aggregate(pairs: PairObservation[]): BusinessNumberAggregate {
  let hardConditionCount = 0;
  let knownHardConditionCount = 0;
  for (const pair of pairs) for (const trace of pair.initial.rule_trace) {
    if (trace.kind !== "required" && trace.kind !== "exclusion") continue;
    hardConditionCount += 1;
    if (trace.result !== "unknown") knownHardConditionCount += 1;
  }
  return {
    pairCount: pairs.length,
    initialEligibilityCounts: eligibilityCounts(pairs.map((pair) => pair.initial.eligibility)),
    immediateDeterminateRate: ratio(pairs.filter((pair) => pair.initial.eligibility !== "conditional").length, pairs.length),
    initialRecommendableCount: pairs.filter((pair) => pair.initial.review_gate?.tier === "recommendable").length,
    initialRecommendableRate: ratio(
      pairs.filter((pair) => pair.initial.review_gate?.tier === "recommendable").length,
      pairs.length,
    ),
    hardConditionKnownRate: ratio(knownHardConditionCount, hardConditionCount),
    falseIneligibleAgainstFullCount: pairs.filter((pair) =>
      pair.initial.eligibility === "ineligible" && pair.full.eligibility === "eligible").length,
    unsafeIneligibleAgainstFullViableCount: pairs.filter((pair) =>
      pair.initial.eligibility === "ineligible" && pair.full.eligibility !== "ineligible").length,
    hardUnknownDimensionCounts: histogramDimensions(pairs.flatMap((pair) => pair.initial.rule_trace
      .filter((trace) => trace.result === "unknown" && (trace.kind === "required" || trace.kind === "exclusion"))
      .map((trace) => trace.dimension))),
    extractionReadinessCounts: extractionReadinessCounts(pairs.map((pair) => pair.initial.quality.extractionReadiness)),
    recommendableByExtractionReadiness: extractionReadinessCounts(pairs
      .filter((pair) => pair.initial.review_gate?.tier === "recommendable")
      .map((pair) => pair.initial.quality.extractionReadiness)),
  };
}

function initialCoverageRows(profile: CompanyProfile): AutofillCoverageRow[] {
  const complete = (dimension: CriterionDimension, present: boolean, sourceKind: "authoritative_api" | "derived"): AutofillCoverageRow => ({
    dimension,
    parentKey: null,
    status: present ? "live" : "pending",
    sourceKind: present ? sourceKind : null,
    axisCompleteness: present ? "complete" : "unknown",
  });
  return [
    complete("region", Boolean(profile.region), "authoritative_api"),
    complete("biz_age", typeof profile.biz_age_months === "number", "derived"),
    { ...complete("industry", Boolean(profile.industries?.length || profile.industry_codes?.length), "authoritative_api"), axisCompleteness: profile.list_completeness?.industry ?? "unknown" },
    complete("size", Boolean(profile.size), "authoritative_api"),
    { ...complete("target_type", Boolean(profile.target_types?.length), "authoritative_api"), axisCompleteness: profile.list_completeness?.target_type ?? "unknown" },
    complete("business_status", profile.business_status?.active !== undefined, "authoritative_api"),
  ];
}

function mergeCoverageRows(rows: AutofillCoverageRow[], companyCount: number): AutofillCoverageRow[] {
  const byDimension = new Map<CriterionDimension, AutofillCoverageRow[]>();
  for (const row of rows) {
    if (row.dimension) byDimension.set(row.dimension, [...(byDimension.get(row.dimension) ?? []), row]);
  }
  return [...byDimension.entries()].map(([dimension, values]) => {
    const completeValues = values.filter((row) => row.axisCompleteness === "complete" && (row.status === "live" || row.status === "cache"));
    const allComplete = completeValues.length === companyCount;
    const authoritative = allComplete && completeValues.every((row) => row.sourceKind === "authoritative_api");
    return {
      dimension,
      parentKey: null,
      status: allComplete ? "live" : "pending",
      sourceKind: allComplete ? (authoritative ? "authoritative_api" : "derived") : null,
      axisCompleteness: allComplete ? "complete" : "unknown",
    };
  });
}

function hardCriterionWeights<TPayload>(grants: Array<NormalizedGrant<TPayload>>): AutofillGrantWeights {
  const weights: AutofillGrantWeights = {};
  for (const grant of grants) for (const criterion of grant.criteria) {
    if (criterion.kind !== "required" && criterion.kind !== "exclusion") continue;
    weights[criterion.dimension] = (weights[criterion.dimension] ?? 0) + 1;
  }
  return weights;
}
function eligibilityCounts(values: Eligibility[]): Record<Eligibility, number> {
  const counts: Record<Eligibility, number> = { eligible: 0, conditional: 0, ineligible: 0 };
  for (const value of values) counts[value] += 1;
  return counts;
}
function histogramDimensions(values: CriterionDimension[]): Partial<Record<CriterionDimension, number>> {
  const result: Partial<Record<CriterionDimension, number>> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function extractionReadinessCounts(values: MatchExtractionReadiness[]): Record<MatchExtractionReadiness, number> {
  const result: Record<MatchExtractionReadiness, number> = {
    reviewed: 0,
    structured_unreviewed: 0,
    partial: 0,
    unstructured: 0,
  };
  for (const value of values) result[value] += 1;
  return result;
}
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}
