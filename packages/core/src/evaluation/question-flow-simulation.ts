import type {
  CompanyProfile,
  CriterionDimension,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import { evaluateProfileUpdateImpact, type ProfileUpdateImpact } from "../use-cases/evaluate-profile-update-impact.js";
import type { MatchedGrant } from "../use-cases/match-card.js";
import {
  projectBusinessNumberInitialProfile,
  type BusinessKind,
  type BusinessNumberCompanyFixture,
} from "./business-number-first-results.js";

export interface SimulatedQuestionStep {
  sequence: number;
  dimension: CriterionDimension;
  affectedGrantCount: number;
  answerAvailable: boolean;
  impact: ProfileUpdateImpact | null;
}

export interface SimulatedCompanyQuestionFlow {
  companyId: string;
  businessKind: BusinessKind;
  initialConditionalCount: number;
  finalConditionalCount: number;
  resolvedInitialConditionalCount: number;
  conditionalResolutionRate: number | null;
  questionCount: number;
  questionsToFirstResolution: number | null;
  reachedQuestionLimit: boolean;
  finalConditionalNoHardUnknownCount: number;
  finalHardUnknownDimensionCounts: Partial<Record<CriterionDimension, number>>;
  finalConditionalExtractionReadinessCounts: Record<MatchExtractionReadiness, number>;
  steps: SimulatedQuestionStep[];
}

export interface QuestionFlowAggregate {
  companyCount: number;
  initialConditionalCount: number;
  finalConditionalCount: number;
  resolvedInitialConditionalCount: number;
  cohortConditionalResolutionRate: number | null;
  eventTargetedConditionalCount: number;
  eventEligibilityResolvedCount: number;
  eventConditionalResolutionRate: number | null;
  questionsAskedP50: number | null;
  questionsToFirstResolutionP50: number | null;
  companiesWithFirstResolution: number;
  companiesWithoutFirstResolution: number;
  reachedQuestionLimitCount: number;
  finalConditionalNoHardUnknownCount: number;
  finalHardUnknownDimensionCounts: Partial<Record<CriterionDimension, number>>;
  finalConditionalExtractionReadinessCounts: Record<MatchExtractionReadiness, number>;
}

export interface QuestionFlowSimulationReport extends QuestionFlowAggregate {
  simulationKind: "synthetic_full_profile_answer_oracle";
  operationalAccuracyEvidence: false;
  grantCount: number;
  maxQuestionsPerCompany: number;
  byBusinessKind: Record<BusinessKind, QuestionFlowAggregate>;
  questionDimensionCounts: Partial<Record<CriterionDimension, number>>;
  companies: SimulatedCompanyQuestionFlow[];
}

/**
 * 완전 synthetic 프로필을 답변 oracle로 삼아 현재 사업자번호 초기 프로필부터 질문을 순차 적용한다.
 * 운영 사용자 행동이나 실제 자동조회 정확도를 대체하지 않는 read-only ceiling simulation이다.
 */
export function buildQuestionFlowSimulationReport<TPayload>(input: {
  companies: BusinessNumberCompanyFixture[];
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  maxQuestionsPerCompany?: number;
}): QuestionFlowSimulationReport {
  const asOf = input.asOf ?? new Date();
  const maxQuestionsPerCompany = boundedQuestionLimit(input.maxQuestionsPerCompany ?? 10);
  const companies = input.companies.map((company) => simulateCompanyQuestionFlow({
    company,
    grants: input.grants,
    asOf,
    maxQuestions: maxQuestionsPerCompany,
  }));
  return {
    simulationKind: "synthetic_full_profile_answer_oracle",
    operationalAccuracyEvidence: false,
    grantCount: input.grants.length,
    maxQuestionsPerCompany,
    ...aggregate(companies),
    byBusinessKind: {
      individual: aggregate(companies.filter((company) => company.businessKind === "individual")),
      corporation: aggregate(companies.filter((company) => company.businessKind === "corporation")),
    },
    questionDimensionCounts: histogram(companies.flatMap((company) => company.steps.map((step) => step.dimension))),
    companies,
  };
}

function simulateCompanyQuestionFlow<TPayload>(input: {
  company: BusinessNumberCompanyFixture;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  maxQuestions: number;
}): SimulatedCompanyQuestionFlow {
  const initialProfile = projectBusinessNumberInitialProfile(input.company.profile, input.company.businessKind);
  let currentProfile = initialProfile;
  const initialMatches = input.grants.map((grant) => matchNormalizedGrant(grant, initialProfile));
  const initialConditionalCount = initialMatches.filter((match) => match.eligibility === "conditional").length;
  const excludedDimensions = new Set<CriterionDimension>();
  const steps: SimulatedQuestionStep[] = [];
  let questionsToFirstResolution: number | null = null;

  while (steps.length < input.maxQuestions) {
    const matched = input.grants.map<MatchedGrant<TPayload>>((item) => ({
      item,
      match: matchNormalizedGrant(item, currentProfile),
    }));
    const planned = planProfileQuestions(matched, {
      asOf: input.asOf,
      limit: 1,
      excludeDimensions: [...excludedDimensions],
    })[0];
    if (!planned) break;
    const dimension = planned.question.dimension;
    const revealed = revealDimension(currentProfile, input.company.profile, dimension);
    const impact = revealed
      ? evaluateProfileUpdateImpact({
          grants: input.grants,
          beforeProfile: currentProfile,
          afterProfile: revealed,
          dimension,
          windowLimit: input.grants.length,
        })
      : null;
    steps.push({
      sequence: steps.length + 1,
      dimension,
      affectedGrantCount: planned.question.affectedGrantCount,
      answerAvailable: revealed !== null,
      impact,
    });
    if (questionsToFirstResolution === null && (impact?.eligibilityResolvedCount ?? 0) > 0) {
      questionsToFirstResolution = steps.length;
    }
    excludedDimensions.add(dimension);
    if (revealed) currentProfile = revealed;
  }

  const finalMatches = input.grants.map((grant) => matchNormalizedGrant(grant, currentProfile));
  let resolvedInitialConditionalCount = 0;
  for (let index = 0; index < initialMatches.length; index += 1) {
    if (initialMatches[index]?.eligibility === "conditional" && finalMatches[index]?.eligibility !== "conditional") {
      resolvedInitialConditionalCount += 1;
    }
  }
  const finalConditionalCount = finalMatches.filter((match) => match.eligibility === "conditional").length;
  const finalConditionalMatches = finalMatches.filter((match) => match.eligibility === "conditional");
  const hardUnknownDimensions = finalConditionalMatches.map((match) => match.rule_trace
    .filter((trace) => trace.result === "unknown" && (trace.kind === "required" || trace.kind === "exclusion"))
    .map((trace) => trace.dimension));
  const hasRemainingQuestion = planProfileQuestions(
    input.grants.map<MatchedGrant<TPayload>>((item) => ({ item, match: matchNormalizedGrant(item, currentProfile) })),
    { asOf: input.asOf, limit: 1, excludeDimensions: [...excludedDimensions] },
  ).length > 0;
  return {
    companyId: input.company.companyId,
    businessKind: input.company.businessKind,
    initialConditionalCount,
    finalConditionalCount,
    resolvedInitialConditionalCount,
    conditionalResolutionRate: ratio(resolvedInitialConditionalCount, initialConditionalCount),
    questionCount: steps.length,
    questionsToFirstResolution,
    reachedQuestionLimit: steps.length >= input.maxQuestions && hasRemainingQuestion,
    finalConditionalNoHardUnknownCount: hardUnknownDimensions.filter((dimensions) => dimensions.length === 0).length,
    finalHardUnknownDimensionCounts: histogram(hardUnknownDimensions.flat()),
    finalConditionalExtractionReadinessCounts: readinessHistogram(
      finalConditionalMatches.map((match) => match.quality.extractionReadiness),
    ),
    steps,
  };
}

function revealDimension(
  current: CompanyProfile,
  oracle: CompanyProfile,
  dimension: CriterionDimension,
): CompanyProfile | null {
  const next = structuredClone(current);
  const setConfidence = () => {
    next.confidence = { ...(next.confidence ?? {}), [dimension]: oracle.confidence?.[dimension] ?? 0.6 };
  };
  const setList = (profileKey: "industries" | "traits" | "certs" | "prior_awards" | "ip" | "target_types") => {
    const value = oracle[profileKey];
    if (!Array.isArray(value)) return false;
    next[profileKey] = [...value];
    const listDimension = dimension as keyof NonNullable<CompanyProfile["list_completeness"]>;
    next.list_completeness = {
      ...(next.list_completeness ?? {}),
      [listDimension]: oracle.list_completeness?.[listDimension] ?? "complete",
    };
    setConfidence();
    return true;
  };

  switch (dimension) {
    case "region":
      if (!oracle.region) return null;
      next.region = { ...oracle.region };
      break;
    case "biz_age":
      if (typeof oracle.biz_age_months !== "number") return null;
      next.biz_age_months = oracle.biz_age_months;
      break;
    case "founder_age":
      if (typeof oracle.founder_age !== "number") return null;
      next.founder_age = oracle.founder_age;
      break;
    case "industry":
      if (!setList("industries")) return null;
      next.industry_codes = [...(oracle.industry_codes ?? [])];
      return next;
    case "size":
      if (!oracle.size) return null;
      next.size = oracle.size;
      break;
    case "revenue":
      if (typeof oracle.revenue_krw !== "number") return null;
      next.revenue_krw = oracle.revenue_krw;
      break;
    case "employees":
      if (typeof oracle.employees_count !== "number") return null;
      next.employees_count = oracle.employees_count;
      break;
    case "founder_trait":
      return setList("traits") ? next : null;
    case "certification":
      return setList("certs") ? next : null;
    case "prior_award":
      return setList("prior_awards") ? next : null;
    case "ip":
      return setList("ip") ? next : null;
    case "target_type":
      return setList("target_types") ? next : null;
    case "business_status":
      if (!oracle.business_status) return null;
      next.business_status = { ...oracle.business_status };
      break;
    case "tax_compliance":
    case "credit_status":
    case "sanction": {
      const value = oracle[dimension];
      if (!value) return null;
      next[dimension] = structuredClone(value);
      break;
    }
    case "financial_health":
    case "insured_workforce":
    case "investment": {
      const value = oracle[dimension];
      if (!value) return null;
      next[dimension] = structuredClone(value);
      break;
    }
    default:
      return null;
  }
  setConfidence();
  return next;
}

function aggregate(companies: SimulatedCompanyQuestionFlow[]): QuestionFlowAggregate {
  const steps = companies.flatMap((company) => company.steps);
  const impacts = steps.flatMap((step) => step.impact ? [step.impact] : []);
  const initialConditionalCount = sum(companies.map((company) => company.initialConditionalCount));
  const resolvedInitialConditionalCount = sum(companies.map((company) => company.resolvedInitialConditionalCount));
  const firstResolutionCounts = companies.flatMap((company) =>
    company.questionsToFirstResolution === null ? [] : [company.questionsToFirstResolution]);
  return {
    companyCount: companies.length,
    initialConditionalCount,
    finalConditionalCount: sum(companies.map((company) => company.finalConditionalCount)),
    resolvedInitialConditionalCount,
    cohortConditionalResolutionRate: ratio(resolvedInitialConditionalCount, initialConditionalCount),
    eventTargetedConditionalCount: sum(impacts.map((impact) => impact.targetedConditionalCount)),
    eventEligibilityResolvedCount: sum(impacts.map((impact) => impact.eligibilityResolvedCount)),
    eventConditionalResolutionRate: ratio(
      sum(impacts.map((impact) => impact.eligibilityResolvedCount)),
      sum(impacts.map((impact) => impact.targetedConditionalCount)),
    ),
    questionsAskedP50: median(companies.map((company) => company.questionCount)),
    questionsToFirstResolutionP50: median(firstResolutionCounts),
    companiesWithFirstResolution: firstResolutionCounts.length,
    companiesWithoutFirstResolution: companies.length - firstResolutionCounts.length,
    reachedQuestionLimitCount: companies.filter((company) => company.reachedQuestionLimit).length,
    finalConditionalNoHardUnknownCount: sum(companies.map((company) => company.finalConditionalNoHardUnknownCount)),
    finalHardUnknownDimensionCounts: mergeDimensionHistograms(
      companies.map((company) => company.finalHardUnknownDimensionCounts),
    ),
    finalConditionalExtractionReadinessCounts: mergeReadinessHistograms(
      companies.map((company) => company.finalConditionalExtractionReadinessCounts),
    ),
  };
}

function boundedQuestionLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 19) throw new Error("maxQuestionsPerCompany must be 1..19");
  return value;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint] ?? null;
  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function histogram(values: CriterionDimension[]): Partial<Record<CriterionDimension, number>> {
  const result: Partial<Record<CriterionDimension, number>> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function readinessHistogram(values: MatchExtractionReadiness[]): Record<MatchExtractionReadiness, number> {
  const result: Record<MatchExtractionReadiness, number> = {
    reviewed: 0,
    structured_unreviewed: 0,
    partial: 0,
    unstructured: 0,
  };
  for (const value of values) result[value] += 1;
  return result;
}

function mergeDimensionHistograms(
  values: Array<Partial<Record<CriterionDimension, number>>>,
): Partial<Record<CriterionDimension, number>> {
  const result: Partial<Record<CriterionDimension, number>> = {};
  for (const value of values) for (const [dimension, count] of Object.entries(value)) {
    const key = dimension as CriterionDimension;
    result[key] = (result[key] ?? 0) + (count ?? 0);
  }
  return result;
}

function mergeReadinessHistograms(
  values: Array<Record<MatchExtractionReadiness, number>>,
): Record<MatchExtractionReadiness, number> {
  const result = readinessHistogram([]);
  for (const value of values) for (const readiness of Object.keys(result) as MatchExtractionReadiness[]) {
    result[readiness] += value[readiness];
  }
  return result;
}
