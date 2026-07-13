import type { GrantCriterion } from "@cunote/contracts";
import type { V3CriterionAnnotation, V3GrantAnnotation, V3LabelStatus } from "./v3-annotations.js";

export interface CriterionExtractionPrediction {
  grantId: string;
  criteria: GrantCriterion[];
}

export interface CriterionExtractionMetric {
  expected: number;
  structuredRecovered: number;
  textOnlyPreserved: number;
  recovered: number;
  missing: number;
  recall: number | null;
  structuredRecall: number | null;
}

export interface CriterionExtractionEvalReport {
  operationalReady: boolean;
  requiredLabelStatus: V3LabelStatus;
  evaluatedGrantCount: number;
  excludedGrantCount: number;
  predictedCriterionCount: number;
  unmatchedPredictedCount: number;
  goldEvidenceCoverage: number | null;
  overall: CriterionExtractionMetric;
  bySource: Record<string, CriterionExtractionMetric>;
  byDimension: Record<string, CriterionExtractionMetric>;
  byKind: Record<string, CriterionExtractionMetric>;
  missing: Array<{
    grantId: string;
    source: string;
    criterionId: string;
    dimension: string;
    kind: string;
    sourceSpan: string | null;
  }>;
}

interface GoldOutcome {
  grant: V3GrantAnnotation;
  criterion: V3CriterionAnnotation;
  result: "structured" | "text_only" | "missing";
  predictionIndex: number | null;
}

export function evaluateCriterionExtraction(
  annotations: V3GrantAnnotation[],
  predictions: CriterionExtractionPrediction[],
  options: { labelStatus?: V3LabelStatus } = {},
): CriterionExtractionEvalReport {
  const requiredLabelStatus = options.labelStatus ?? "reviewed";
  const goldGrants = annotations.filter((grant) => grant.labelStatus === requiredLabelStatus);
  const predictionByGrant = new Map(predictions.map((prediction) => [prediction.grantId, prediction.criteria]));
  const outcomes: GoldOutcome[] = [];
  let predictedCriterionCount = 0;
  let unmatchedPredictedCount = 0;

  for (const grant of goldGrants) {
    const predicted = predictionByGrant.get(grant.grantId) ?? [];
    predictedCriterionCount += predicted.length;
    const used = new Set<number>();
    for (const criterion of grant.criteria) {
      const match = bestPrediction(criterion, predicted, used);
      if (match) used.add(match.index);
      outcomes.push({
        grant,
        criterion,
        result: match?.result ?? "missing",
        predictionIndex: match?.index ?? null,
      });
    }
    unmatchedPredictedCount += predicted.length - used.size;
  }

  return {
    operationalReady: requiredLabelStatus === "reviewed" && goldGrants.length > 0,
    requiredLabelStatus,
    evaluatedGrantCount: goldGrants.length,
    excludedGrantCount: annotations.length - goldGrants.length,
    predictedCriterionCount,
    unmatchedPredictedCount,
    goldEvidenceCoverage: outcomes.length === 0
      ? null
      : outcomes.filter((outcome) => outcome.criterion.sourceSpan || outcome.criterion.sourceField).length / outcomes.length,
    overall: metric(outcomes),
    bySource: groupedMetrics(outcomes, (outcome) => outcome.grant.source),
    byDimension: groupedMetrics(outcomes, (outcome) => outcome.criterion.dimension),
    byKind: groupedMetrics(outcomes, (outcome) => outcome.criterion.kind),
    missing: outcomes
      .filter((outcome) => outcome.result === "missing")
      .map((outcome) => ({
        grantId: outcome.grant.grantId,
        source: outcome.grant.source,
        criterionId: outcome.criterion.criterionId,
        dimension: outcome.criterion.dimension,
        kind: outcome.criterion.kind,
        sourceSpan: outcome.criterion.sourceSpan,
      })),
  };
}

function bestPrediction(
  gold: V3CriterionAnnotation,
  predictions: GrantCriterion[],
  used: Set<number>,
): { index: number; result: "structured" | "text_only" } | null {
  const candidates = predictions
    .map((prediction, index) => ({ prediction, index, score: predictionScore(gold, prediction) }))
    .filter((candidate) => !used.has(candidate.index) && candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = candidates[0];
  if (!best) return null;
  if (best.prediction.operator === "text_only") {
    return spansOverlap(gold.sourceSpan, best.prediction.source_span) ? { index: best.index, result: "text_only" } : null;
  }
  if (
    best.prediction.dimension === gold.dimension &&
    best.prediction.kind === gold.kind &&
    best.prediction.operator === gold.operator &&
    valuesEquivalent(best.prediction.value, gold.value)
  ) {
    return { index: best.index, result: "structured" };
  }
  return null;
}

function predictionScore(gold: V3CriterionAnnotation, prediction: GrantCriterion): number {
  if (prediction.operator === "text_only" && spansOverlap(gold.sourceSpan, prediction.source_span)) return 5;
  if (prediction.dimension !== gold.dimension || prediction.kind !== gold.kind) return 0;
  let score = 2;
  if (prediction.operator === gold.operator) score += 2;
  if (valuesEquivalent(prediction.value, gold.value)) score += 4;
  if (gold.sourceField && prediction.source_field === gold.sourceField) score += 1;
  if (spansOverlap(gold.sourceSpan, prediction.source_span)) score += 1;
  return score;
}

function valuesEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return typeof value === "string" ? value.trim() : value;
}

function spansOverlap(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeSpan(left);
  const b = normalizeSpan(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 12 && b.includes(a)) || (b.length >= 12 && a.includes(b));
}

function normalizeSpan(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function metric(outcomes: GoldOutcome[]): CriterionExtractionMetric {
  const structuredRecovered = outcomes.filter((outcome) => outcome.result === "structured").length;
  const textOnlyPreserved = outcomes.filter((outcome) => outcome.result === "text_only").length;
  const recovered = structuredRecovered + textOnlyPreserved;
  const expected = outcomes.length;
  return {
    expected,
    structuredRecovered,
    textOnlyPreserved,
    recovered,
    missing: expected - recovered,
    recall: expected === 0 ? null : recovered / expected,
    structuredRecall: expected === 0 ? null : structuredRecovered / expected,
  };
}

function groupedMetrics(
  outcomes: GoldOutcome[],
  keyFor: (outcome: GoldOutcome) => string,
): Record<string, CriterionExtractionMetric> {
  const keys = [...new Set(outcomes.map(keyFor))].sort();
  return Object.fromEntries(keys.map((key) => [key, metric(outcomes.filter((outcome) => keyFor(outcome) === key))]));
}
