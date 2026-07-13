import type { CriterionDimension } from "@cunote/contracts";

export interface ProfileQuestionQualityRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  rulesetVer: string;
  dimension: CriterionDimension;
  targetedConditionalCount: number;
  dimensionResolvedGrantCount: number;
  eligibilityResolvedCount: number;
}

export interface ProfileQuestionDimensionQuality {
  eventCount: number;
  targetedConditionalCount: number;
  dimensionResolvedGrantCount: number;
  eligibilityResolvedCount: number;
  dimensionResolutionRate: number | null;
  conditionalResolutionRate: number | null;
}

export interface ProfileQuestionQualityReport {
  periodStart: string;
  periodEnd: string;
  eventCount: number;
  sessionCount: number;
  resolvedSessionCount: number;
  unresolvedSessionCount: number;
  targetedConditionalCount: number;
  dimensionResolvedGrantCount: number;
  eligibilityResolvedCount: number;
  dimensionResolutionRate: number | null;
  conditionalResolutionRate: number | null;
  questionsToFirstResolutionP50: number | null;
  rulesetCounts: Record<string, number>;
  mixedRulesets: boolean;
  byDimension: Partial<Record<CriterionDimension, ProfileQuestionDimensionQuality>>;
  sampleReady: boolean;
  operationalReady: boolean;
}

export function buildProfileQuestionQualityReport(input: {
  records: ProfileQuestionQualityRecord[];
  periodStart: Date;
  periodEnd: Date;
  minimumEvents?: number;
  minimumSessions?: number;
}): ProfileQuestionQualityReport {
  const records = input.records.filter(validRecord);
  const sessions = groupBy(records, (record) => record.sessionId);
  const firstResolutionQuestionCounts: number[] = [];
  let unresolvedSessionCount = 0;
  for (const sessionRecords of sessions.values()) {
    const ordered = [...sessionRecords].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
    const firstResolvedIndex = ordered.findIndex((record) => record.eligibilityResolvedCount > 0);
    if (firstResolvedIndex < 0) unresolvedSessionCount += 1;
    else firstResolutionQuestionCounts.push(firstResolvedIndex + 1);
  }

  const totals = summarize(records);
  const byDimension: ProfileQuestionQualityReport["byDimension"] = {};
  for (const [dimension, dimensionRecords] of groupBy(records, (record) => record.dimension)) {
    byDimension[dimension] = summarize(dimensionRecords);
  }
  const minimumEvents = input.minimumEvents ?? 30;
  const minimumSessions = input.minimumSessions ?? 10;
  const sampleReady = records.length >= minimumEvents && sessions.size >= minimumSessions;
  const p50 = median(firstResolutionQuestionCounts);
  const rulesetCounts = histogram(records.map((record) => record.rulesetVer));
  const mixedRulesets = Object.keys(rulesetCounts).length > 1;
  const operationalReady = sampleReady && !mixedRulesets &&
    totals.conditionalResolutionRate !== null && totals.conditionalResolutionRate >= 0.6 &&
    p50 !== null && p50 <= 3;

  return {
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    sessionCount: sessions.size,
    resolvedSessionCount: firstResolutionQuestionCounts.length,
    unresolvedSessionCount,
    ...totals,
    questionsToFirstResolutionP50: p50,
    rulesetCounts,
    mixedRulesets,
    byDimension,
    sampleReady,
    operationalReady,
  };
}

function summarize(records: ProfileQuestionQualityRecord[]): ProfileQuestionDimensionQuality {
  const targetedConditionalCount = sum(records.map((record) => record.targetedConditionalCount));
  const dimensionResolvedGrantCount = sum(records.map((record) => record.dimensionResolvedGrantCount));
  const eligibilityResolvedCount = sum(records.map((record) => record.eligibilityResolvedCount));
  return {
    eventCount: records.length,
    targetedConditionalCount,
    dimensionResolvedGrantCount,
    eligibilityResolvedCount,
    dimensionResolutionRate: ratio(dimensionResolvedGrantCount, targetedConditionalCount),
    conditionalResolutionRate: ratio(eligibilityResolvedCount, targetedConditionalCount),
  };
}

function validRecord(record: ProfileQuestionQualityRecord): boolean {
  return Boolean(record.id && record.sessionId && record.rulesetVer && !Number.isNaN(new Date(record.timestamp).getTime())) &&
    [record.targetedConditionalCount, record.dimensionResolvedGrantCount, record.eligibilityResolvedCount]
      .every((value) => Number.isInteger(value) && value >= 0) &&
    record.dimensionResolvedGrantCount <= record.targetedConditionalCount &&
    record.eligibilityResolvedCount <= record.targetedConditionalCount;
}

function groupBy<K, V>(values: V[], key: (value: V) => K): Map<K, V[]> {
  const result = new Map<K, V[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]);
  return result;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint] ?? null;
  const left = sorted[midpoint - 1];
  const right = sorted[midpoint];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
