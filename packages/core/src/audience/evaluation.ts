import type { GrantAudience, GrantSource } from "@cunote/contracts";

export type AudienceLabelStatus = "draft" | "reviewed";

export interface GrantAudienceAnnotation {
  recordType: "grant_audience_annotation";
  schemaVersion: "grant-audience-v1";
  grantId: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  sourceRevision: string;
  expectedAudience: GrantAudience;
  labelStatus: AudienceLabelStatus;
  annotatorId: string | null;
  annotatedAt: string | null;
  reviewerId: string | null;
  reviewedAt: string | null;
  note: string;
}

export interface GrantAudiencePrediction {
  grantId: string;
  predictedAudience: GrantAudience;
  safeToExcludeFromBusinessMatching: boolean;
}

export interface GrantAudienceEvaluationReport {
  operationalReady: boolean;
  reviewedCount: number;
  excludedDraftCount: number;
  actualIndividualCount: number;
  predictedSafeIndividualCount: number;
  individualPrecision: number | null;
  individualRecall: number | null;
  businessPreservationRecall: number | null;
  exactAccuracy: number | null;
  confusion: Record<string, number>;
  gate: {
    minimumReviewed: boolean;
    minimumIndividual: boolean;
    individualPrecision: boolean;
    businessPreservationRecall: boolean;
    passed: boolean;
  };
  errors: Array<{
    grantId: string;
    expectedAudience: GrantAudience;
    predictedAudience: GrantAudience;
    safeToExcludeFromBusinessMatching: boolean;
  }>;
}

export function parseGrantAudienceAnnotationJsonl(
  text: string,
  sourceName = "grant-audience-annotations.jsonl",
): GrantAudienceAnnotation[] {
  const records = text.split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), location: `${sourceName}:${index + 1}` }))
    .filter((entry) => entry.line && !entry.line.startsWith("#"))
    .map((entry) => parseAnnotation(entry.line, entry.location));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.grantId)) throw new Error(`${sourceName}: duplicate grantId ${record.grantId}`);
    seen.add(record.grantId);
  }
  return records;
}

export function evaluateGrantAudience(
  annotations: GrantAudienceAnnotation[],
  predictions: GrantAudiencePrediction[],
): GrantAudienceEvaluationReport {
  const reviewed = annotations.filter((annotation) => annotation.labelStatus === "reviewed");
  const predictionByGrant = new Map(predictions.map((prediction) => [prediction.grantId, prediction]));
  const pairs = reviewed.map((annotation) => {
    const prediction = predictionByGrant.get(annotation.grantId);
    if (!prediction) throw new Error(`missing audience prediction: ${annotation.grantId}`);
    return { annotation, prediction };
  });
  const actualIndividualCount = pairs.filter(({ annotation }) => annotation.expectedAudience === "individual").length;
  const predictedSafe = pairs.filter(({ prediction }) =>
    prediction.predictedAudience === "individual" && prediction.safeToExcludeFromBusinessMatching);
  const individualTruePositive = predictedSafe.filter(({ annotation }) => annotation.expectedAudience === "individual").length;
  const actualBusiness = pairs.filter(({ annotation }) =>
    annotation.expectedAudience === "company" || annotation.expectedAudience === "mixed");
  const preservedBusiness = actualBusiness.filter(({ prediction }) =>
    !(prediction.predictedAudience === "individual" && prediction.safeToExcludeFromBusinessMatching));
  const exact = pairs.filter(({ annotation, prediction }) =>
    annotation.expectedAudience === prediction.predictedAudience).length;
  const individualPrecision = ratio(individualTruePositive, predictedSafe.length);
  const individualRecall = ratio(individualTruePositive, actualIndividualCount);
  const businessPreservationRecall = ratio(preservedBusiness.length, actualBusiness.length);
  const exactAccuracy = ratio(exact, pairs.length);
  const gate = {
    minimumReviewed: pairs.length >= 60,
    minimumIndividual: actualIndividualCount >= 20,
    individualPrecision: individualPrecision !== null && individualPrecision >= 0.95,
    businessPreservationRecall: businessPreservationRecall !== null && businessPreservationRecall >= 0.98,
    passed: false,
  };
  gate.passed = gate.minimumReviewed && gate.minimumIndividual && gate.individualPrecision && gate.businessPreservationRecall;
  return {
    operationalReady: gate.passed,
    reviewedCount: pairs.length,
    excludedDraftCount: annotations.length - reviewed.length,
    actualIndividualCount,
    predictedSafeIndividualCount: predictedSafe.length,
    individualPrecision,
    individualRecall,
    businessPreservationRecall,
    exactAccuracy,
    confusion: histogram(pairs.map(({ annotation, prediction }) =>
      `${annotation.expectedAudience}->${prediction.predictedAudience}`)),
    gate,
    errors: pairs
      .filter(({ annotation, prediction }) => annotation.expectedAudience !== prediction.predictedAudience)
      .map(({ annotation, prediction }) => ({
        grantId: annotation.grantId,
        expectedAudience: annotation.expectedAudience,
        predictedAudience: prediction.predictedAudience,
        safeToExcludeFromBusinessMatching: prediction.safeToExcludeFromBusinessMatching,
      })),
  };
}

function parseAnnotation(line: string, location: string): GrantAudienceAnnotation {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`${location}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = requireRecord(value, location);
  if (record.recordType !== "grant_audience_annotation") throw new Error(`${location}: invalid recordType`);
  if (record.schemaVersion !== "grant-audience-v1") throw new Error(`${location}: invalid schemaVersion`);
  const source = grantSource(record.source, `${location}.source`);
  const sourceId = string(record.sourceId, `${location}.sourceId`);
  const grantId = string(record.grantId, `${location}.grantId`);
  if (grantId !== `${source}:${sourceId}`) throw new Error(`${location}: grantId must equal source:sourceId`);
  const labelStatus = oneOf(record.labelStatus, ["draft", "reviewed"] as const, `${location}.labelStatus`);
  const annotation: GrantAudienceAnnotation = {
    recordType: "grant_audience_annotation",
    schemaVersion: "grant-audience-v1",
    grantId,
    source,
    sourceId,
    title: string(record.title, `${location}.title`),
    sourceRevision: string(record.sourceRevision, `${location}.sourceRevision`),
    expectedAudience: oneOf(record.expectedAudience, ["company", "individual", "mixed", "unknown"] as const, `${location}.expectedAudience`),
    labelStatus,
    annotatorId: nullableString(record.annotatorId, `${location}.annotatorId`),
    annotatedAt: nullableString(record.annotatedAt, `${location}.annotatedAt`),
    reviewerId: nullableString(record.reviewerId, `${location}.reviewerId`),
    reviewedAt: nullableString(record.reviewedAt, `${location}.reviewedAt`),
    note: typeof record.note === "string" ? record.note : "",
  };
  if (labelStatus === "reviewed") assertIndependentReview(annotation, location);
  return annotation;
}

function assertIndependentReview(annotation: GrantAudienceAnnotation, location: string): void {
  if (!annotation.annotatorId || !annotation.annotatedAt) throw new Error(`${location}: reviewed label requires annotator metadata`);
  if (!annotation.reviewerId || !annotation.reviewedAt) throw new Error(`${location}: reviewed label requires reviewer metadata`);
  if (annotation.annotatorId.toLowerCase() === annotation.reviewerId.toLowerCase()) {
    throw new Error(`${location}: independent reviewer is required`);
  }
  if (/(^|[^a-z])(ai|llm|gpt|claude|codex|gemini|anthropic|openai)([^a-z]|$)/i.test(annotation.reviewerId)) {
    throw new Error(`${location}: reviewerId must identify a human reviewer`);
  }
  const annotatedAt = date(annotation.annotatedAt, `${location}.annotatedAt`);
  const reviewedAt = date(annotation.reviewedAt, `${location}.reviewedAt`);
  if (reviewedAt.getTime() < annotatedAt.getTime()) throw new Error(`${location}: reviewedAt must not precede annotatedAt`);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value.trim();
}

function nullableString(value: unknown, location: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, location);
}

function grantSource(value: unknown, location: string): GrantSource {
  return oneOf(value, ["kstartup", "bizinfo", "bizinfo_event"] as const, location);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], location: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new Error(`${location}: invalid value`);
  return value as T;
}

function date(value: string, location: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${location}: invalid ISO date`);
  return parsed;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
