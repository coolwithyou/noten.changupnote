import type { Eligibility, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria, RULESET_VERSION, SCORING_VERSION } from "../matching/match.js";
import type {
  V3CompanyAnnotation,
  V3EligibilityPairAnnotation,
  V3GrantAnnotation,
} from "./v3-annotations.js";

export const MATCHING_V3_MVP_THRESHOLDS = Object.freeze({
  eligible_precision: 0.9,
  eligible_recall: 0.95,
  ineligible_precision: 0.97,
});

export const MATCHING_V3_MINIMUM_REVIEWED_PAIRS = 500;

export interface MatchingV3Metric {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface MatchingV3ReviewedEvaluationReport {
  status: "ready" | "not_ready";
  operationalReady: boolean;
  asOf: string;
  rulesetVersion: string;
  scoringVersion: string;
  reviewedCompanyCount: number;
  reviewedGrantCount: number;
  reviewedPairCount: number;
  evaluatedPairCount: number;
  excludedDraftPairCount: number;
  invalidReviewedPairCount: number;
  sampleGate: {
    requiredReviewedPairs: number;
    actualReviewedPairs: number;
    pass: boolean;
  };
  metrics: {
    eligible_precision: MatchingV3Metric;
    /** 실제 eligible을 eligible 또는 conditional로 보존한 비율. */
    eligible_recall: MatchingV3Metric;
    ineligible_precision: MatchingV3Metric;
  };
  mvpThresholds: {
    eligible_precision: { minimum: number; pass: boolean };
    eligible_recall: { minimum: number; pass: boolean };
    ineligible_precision: { minimum: number; pass: boolean };
  };
  gates: {
    reviewedFixture: boolean;
    sampleSize: boolean;
    eligiblePrecision: boolean;
    eligibleRecall: boolean;
    ineligiblePrecision: boolean;
    passed: boolean;
  };
  confusionMatrix: Record<Eligibility, Record<Eligibility, number>>;
  invalidReviewedPairs: Array<{ pairId: string; reason: string }>;
  misclassifications: Array<{
    pairId: string;
    grantId: string;
    companyId: string;
    expected: Eligibility;
    actual: Eligibility;
  }>;
  notReadyReasons: string[];
}

/**
 * Independently reviewed matching-v3 annotations are re-run through the current matcher.
 * This function performs no I/O and does not read the clock; callers must fix `asOf`.
 */
export function evaluateMatchingV3ReviewedFixture(input: {
  companies: V3CompanyAnnotation[];
  grants: V3GrantAnnotation[];
  pairs: V3EligibilityPairAnnotation[];
  asOf: Date;
  minimumReviewedPairs?: number;
}): MatchingV3ReviewedEvaluationReport {
  if (Number.isNaN(input.asOf.getTime())) throw new Error("asOf must be a valid date");
  const minimumReviewedPairs = input.minimumReviewedPairs ?? MATCHING_V3_MINIMUM_REVIEWED_PAIRS;
  if (!Number.isInteger(minimumReviewedPairs) || minimumReviewedPairs < 1) {
    throw new Error("minimumReviewedPairs must be a positive integer");
  }
  assertUniqueIds(input.companies, (company) => company.companyId, "companyId");
  assertUniqueIds(input.grants, (grant) => grant.grantId, "grantId");
  assertUniqueIds(input.pairs, (pair) => pair.pairId, "pairId");

  const reviewedCompanies = input.companies.filter((company) => company.labelStatus === "reviewed");
  const reviewedGrants = input.grants.filter((grant) => grant.labelStatus === "reviewed");
  const reviewedPairs = input.pairs.filter((pair) => pair.labelStatus === "reviewed");
  const companyById = new Map(reviewedCompanies.map((company) => [company.companyId, company]));
  const grantById = new Map(reviewedGrants.map((grant) => [grant.grantId, grant]));
  const invalidReviewedPairs: Array<{ pairId: string; reason: string }> = [];
  const outcomes: Array<{
    pair: V3EligibilityPairAnnotation;
    actual: Eligibility;
  }> = [];

  for (const pair of reviewedPairs) {
    const company = companyById.get(pair.companyId);
    const grant = grantById.get(pair.grantId);
    const missing: string[] = [];
    if (!company) missing.push(`reviewed company ${pair.companyId}`);
    if (!grant) missing.push(`reviewed grant ${pair.grantId}`);
    if (!company || !grant) {
      invalidReviewedPairs.push({ pairId: pair.pairId, reason: `missing ${missing.join(" and ")}` });
      continue;
    }
    const actual = matchGrantCriteria(toGrantCriteria(grant), company.profile, { asOf: input.asOf }).eligibility;
    outcomes.push({ pair, actual });
  }

  const eligiblePrecision = metric(
    outcomes.filter(({ pair, actual }) => actual === "eligible" && pair.expectedEligibility === "eligible").length,
    outcomes.filter(({ actual }) => actual === "eligible").length,
  );
  // false ineligible가 가장 비싸므로 conditional은 실제 eligible을 안전하게 보존한 것으로 센다.
  const eligibleRecall = metric(
    outcomes.filter(({ pair, actual }) => pair.expectedEligibility === "eligible" && actual !== "ineligible").length,
    outcomes.filter(({ pair }) => pair.expectedEligibility === "eligible").length,
  );
  const ineligiblePrecision = metric(
    outcomes.filter(({ pair, actual }) => actual === "ineligible" && pair.expectedEligibility === "ineligible").length,
    outcomes.filter(({ actual }) => actual === "ineligible").length,
  );
  const reviewedFixture = reviewedPairs.length > 0 && invalidReviewedPairs.length === 0;
  const sampleSizePass = outcomes.length >= minimumReviewedPairs;
  const eligiblePrecisionPass = passes(eligiblePrecision, MATCHING_V3_MVP_THRESHOLDS.eligible_precision);
  const eligibleRecallPass = passes(eligibleRecall, MATCHING_V3_MVP_THRESHOLDS.eligible_recall);
  const ineligiblePrecisionPass = passes(ineligiblePrecision, MATCHING_V3_MVP_THRESHOLDS.ineligible_precision);
  const passed = reviewedFixture && sampleSizePass && eligiblePrecisionPass && eligibleRecallPass && ineligiblePrecisionPass;
  const notReadyReasons: string[] = [];
  if (reviewedPairs.length === 0) notReadyReasons.push("no_reviewed_pairs");
  if (invalidReviewedPairs.length > 0) notReadyReasons.push("invalid_reviewed_pair_dependencies");
  if (!sampleSizePass) notReadyReasons.push("insufficient_reviewed_pairs");
  addMetricReason(notReadyReasons, "eligible_precision", eligiblePrecision, eligiblePrecisionPass);
  addMetricReason(notReadyReasons, "eligible_recall", eligibleRecall, eligibleRecallPass);
  addMetricReason(notReadyReasons, "ineligible_precision", ineligiblePrecision, ineligiblePrecisionPass);

  return {
    status: passed ? "ready" : "not_ready",
    operationalReady: passed,
    asOf: input.asOf.toISOString(),
    rulesetVersion: RULESET_VERSION,
    scoringVersion: SCORING_VERSION,
    reviewedCompanyCount: reviewedCompanies.length,
    reviewedGrantCount: reviewedGrants.length,
    reviewedPairCount: reviewedPairs.length,
    evaluatedPairCount: outcomes.length,
    excludedDraftPairCount: input.pairs.length - reviewedPairs.length,
    invalidReviewedPairCount: invalidReviewedPairs.length,
    sampleGate: {
      requiredReviewedPairs: minimumReviewedPairs,
      actualReviewedPairs: outcomes.length,
      pass: sampleSizePass,
    },
    metrics: {
      eligible_precision: eligiblePrecision,
      eligible_recall: eligibleRecall,
      ineligible_precision: ineligiblePrecision,
    },
    mvpThresholds: {
      eligible_precision: {
        minimum: MATCHING_V3_MVP_THRESHOLDS.eligible_precision,
        pass: eligiblePrecisionPass,
      },
      eligible_recall: {
        minimum: MATCHING_V3_MVP_THRESHOLDS.eligible_recall,
        pass: eligibleRecallPass,
      },
      ineligible_precision: {
        minimum: MATCHING_V3_MVP_THRESHOLDS.ineligible_precision,
        pass: ineligiblePrecisionPass,
      },
    },
    gates: {
      reviewedFixture,
      sampleSize: sampleSizePass,
      eligiblePrecision: eligiblePrecisionPass,
      eligibleRecall: eligibleRecallPass,
      ineligiblePrecision: ineligiblePrecisionPass,
      passed,
    },
    confusionMatrix: confusionMatrix(outcomes.map(({ pair, actual }) => ({
      expected: pair.expectedEligibility,
      actual,
    }))),
    invalidReviewedPairs,
    misclassifications: outcomes
      .filter(({ pair, actual }) => pair.expectedEligibility !== actual)
      .map(({ pair, actual }) => ({
        pairId: pair.pairId,
        grantId: pair.grantId,
        companyId: pair.companyId,
        expected: pair.expectedEligibility,
        actual,
      })),
    notReadyReasons,
  };
}

function toGrantCriteria(grant: V3GrantAnnotation): GrantCriterion[] {
  return grant.criteria.map((criterion) => ({
    id: criterion.criterionId,
    grant_id: grant.grantId,
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value as GrantCriterion["value"],
    confidence: criterion.annotationConfidence,
    needs_review: false,
    parser_version: "reviewer:matching-v3",
    ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
    ...(criterion.sourceField ? { source_field: criterion.sourceField } : {}),
  }));
}

function metric(numerator: number, denominator: number): MatchingV3Metric {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000,
  };
}

function passes(metricValue: MatchingV3Metric, threshold: number): boolean {
  return metricValue.denominator > 0 && metricValue.numerator / metricValue.denominator >= threshold;
}

function addMetricReason(
  reasons: string[],
  name: keyof typeof MATCHING_V3_MVP_THRESHOLDS,
  metricValue: MatchingV3Metric,
  pass: boolean,
): void {
  if (pass) return;
  reasons.push(metricValue.value === null ? `${name}_unavailable` : `${name}_below_threshold`);
}

function confusionMatrix(
  outcomes: Array<{ expected: Eligibility; actual: Eligibility }>,
): Record<Eligibility, Record<Eligibility, number>> {
  const matrix: Record<Eligibility, Record<Eligibility, number>> = {
    eligible: { eligible: 0, conditional: 0, ineligible: 0 },
    conditional: { eligible: 0, conditional: 0, ineligible: 0 },
    ineligible: { eligible: 0, conditional: 0, ineligible: 0 },
  };
  for (const outcome of outcomes) matrix[outcome.expected][outcome.actual] += 1;
  return matrix;
}

function assertUniqueIds<T>(values: T[], readId: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = readId(value);
    if (seen.has(id)) throw new Error(`duplicate ${label}: ${id}`);
    seen.add(id);
  }
}
