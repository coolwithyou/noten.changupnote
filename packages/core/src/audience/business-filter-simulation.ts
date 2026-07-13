import type { Eligibility, NormalizedGrant } from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import {
  buildBusinessNumberFirstResultReport,
  projectBusinessNumberInitialProfile,
  type BusinessNumberCompanyFixture,
} from "../evaluation/business-number-first-results.js";
import { buildQuestionFlowSimulationReport } from "../evaluation/question-flow-simulation.js";
import { classifyGrantAudience, type GrantAudienceClassification } from "./classify.js";

export interface BusinessAudienceExcludedGrant {
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  confidence: number;
  stage: GrantAudienceClassification["stage"];
  signals: string[];
  initialEligibilityCounts: Record<Eligibility, number>;
  initialRecommendableCount: number;
}

export interface BusinessAudienceFilterSimulation {
  simulationKind: "safe_individual_business_universe_exclusion";
  operationalAccuracyEvidence: false;
  matchingFilterEnabled: false;
  grantCountBefore: number;
  grantCountAfter: number;
  excludedGrantCount: number;
  audienceCounts: Record<string, number>;
  excluded: BusinessAudienceExcludedGrant[];
  before: BusinessAudienceSimulationMetrics;
  after: BusinessAudienceSimulationMetrics;
  deltas: {
    initialRecommendableCount: number;
    falseIneligibleAgainstFullCount: number;
    unsafeIneligibleAgainstFullViableCount: number;
    initialConditionalCount: number;
    finalConditionalCount: number;
    cohortConditionalResolutionRate: number | null;
  };
  gates: {
    allExcludedAreSafeIndividual: boolean;
    noFalseIneligibleRegression: boolean;
    noUnsafeIneligibleRegression: boolean;
    partialOrUnstructuredRecommendableCount: number;
    readinessGateMaintained: boolean;
    reviewedAudienceGateRequired: true;
  };
}

export interface BusinessAudienceSimulationMetrics {
  initialRecommendableCount: number;
  falseIneligibleAgainstFullCount: number;
  unsafeIneligibleAgainstFullViableCount: number;
  recommendableByExtractionReadiness: Record<string, number>;
  initialConditionalCount: number;
  finalConditionalCount: number;
  cohortConditionalResolutionRate: number | null;
  eventConditionalResolutionRate: number | null;
  questionsToFirstResolutionP50: number | null;
}

export function simulateBusinessAudienceFilter<TPayload>(input: {
  grants: Array<NormalizedGrant<TPayload>>;
  companies: BusinessNumberCompanyFixture[];
  asOf?: Date;
}): BusinessAudienceFilterSimulation {
  const asOf = input.asOf ?? new Date();
  const classified = input.grants.map((grant) => ({
    grant,
    classification: classifyGrantAudience({
      source: grant.grant.source,
      title: grant.grant.title,
      payload: grant.raw.payload,
    }),
  }));
  const excludedRows = classified.filter(({ classification }) =>
    classification.audience === "individual" && classification.safeToExcludeFromBusinessMatching);
  const excludedIds = new Set(excludedRows.map(({ grant }) => grantId(grant)));
  const filteredGrants = input.grants.filter((grant) => !excludedIds.has(grantId(grant)));
  const before = metrics(input.grants, input.companies, asOf);
  const after = metrics(filteredGrants, input.companies, asOf);
  const partialOrUnstructuredRecommendableCount =
    (after.recommendableByExtractionReadiness.partial ?? 0) +
    (after.recommendableByExtractionReadiness.unstructured ?? 0);
  return {
    simulationKind: "safe_individual_business_universe_exclusion",
    operationalAccuracyEvidence: false,
    matchingFilterEnabled: false,
    grantCountBefore: input.grants.length,
    grantCountAfter: filteredGrants.length,
    excludedGrantCount: excludedRows.length,
    audienceCounts: histogram(classified.map(({ classification }) => classification.audience)),
    excluded: excludedRows.map(({ grant, classification }) => excludedGrant(grant, classification, input.companies)),
    before,
    after,
    deltas: {
      initialRecommendableCount: after.initialRecommendableCount - before.initialRecommendableCount,
      falseIneligibleAgainstFullCount:
        after.falseIneligibleAgainstFullCount - before.falseIneligibleAgainstFullCount,
      unsafeIneligibleAgainstFullViableCount:
        after.unsafeIneligibleAgainstFullViableCount - before.unsafeIneligibleAgainstFullViableCount,
      initialConditionalCount: after.initialConditionalCount - before.initialConditionalCount,
      finalConditionalCount: after.finalConditionalCount - before.finalConditionalCount,
      cohortConditionalResolutionRate: nullableDelta(
        after.cohortConditionalResolutionRate,
        before.cohortConditionalResolutionRate,
      ),
    },
    gates: {
      allExcludedAreSafeIndividual: excludedRows.every(({ classification }) =>
        classification.audience === "individual" && classification.safeToExcludeFromBusinessMatching),
      noFalseIneligibleRegression: after.falseIneligibleAgainstFullCount <= before.falseIneligibleAgainstFullCount,
      noUnsafeIneligibleRegression:
        after.unsafeIneligibleAgainstFullViableCount <= before.unsafeIneligibleAgainstFullViableCount,
      partialOrUnstructuredRecommendableCount,
      readinessGateMaintained: partialOrUnstructuredRecommendableCount === 0,
      reviewedAudienceGateRequired: true,
    },
  };
}

function metrics<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  companies: BusinessNumberCompanyFixture[],
  asOf: Date,
): BusinessAudienceSimulationMetrics {
  const business = buildBusinessNumberFirstResultReport({ grants, companies, asOf });
  const questions = buildQuestionFlowSimulationReport({ grants, companies, asOf });
  return {
    initialRecommendableCount: business.initialRecommendableCount,
    falseIneligibleAgainstFullCount: business.falseIneligibleAgainstFullCount,
    unsafeIneligibleAgainstFullViableCount: business.unsafeIneligibleAgainstFullViableCount,
    recommendableByExtractionReadiness: business.recommendableByExtractionReadiness,
    initialConditionalCount: questions.initialConditionalCount,
    finalConditionalCount: questions.finalConditionalCount,
    cohortConditionalResolutionRate: questions.cohortConditionalResolutionRate,
    eventConditionalResolutionRate: questions.eventConditionalResolutionRate,
    questionsToFirstResolutionP50: questions.questionsToFirstResolutionP50,
  };
}

function excludedGrant<TPayload>(
  grant: NormalizedGrant<TPayload>,
  classification: GrantAudienceClassification,
  companies: BusinessNumberCompanyFixture[],
): BusinessAudienceExcludedGrant {
  const matches = companies.map((company) => matchNormalizedGrant(
    grant,
    projectBusinessNumberInitialProfile(company.profile, company.businessKind),
  ));
  return {
    grantId: grantId(grant),
    source: grant.grant.source,
    sourceId: grant.grant.source_id,
    title: grant.grant.title,
    confidence: classification.confidence,
    stage: classification.stage,
    signals: classification.signals,
    initialEligibilityCounts: eligibilityHistogram(matches.map((match) => match.eligibility)),
    initialRecommendableCount: matches.filter((match) => match.review_gate?.tier === "recommendable").length,
  };
}

function grantId<TPayload>(grant: NormalizedGrant<TPayload>): string {
  return `${grant.grant.source}:${grant.grant.source_id}`;
}

function eligibilityHistogram(values: Eligibility[]): Record<Eligibility, number> {
  const result: Record<Eligibility, number> = { eligible: 0, conditional: 0, ineligible: 0 };
  for (const value of values) result[value] += 1;
  return result;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function nullableDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return Math.round((after - before) * 10_000) / 10_000;
}
