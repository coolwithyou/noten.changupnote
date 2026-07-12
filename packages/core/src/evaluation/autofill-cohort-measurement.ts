import { createHmac } from "node:crypto";
import type { CriterionDimension } from "@cunote/contracts";
import {
  measureAutofillCoverage,
  type AutofillCoverageMetrics,
  type AutofillCoverageRow,
  type AutofillGrantWeights,
} from "../autofill/coverage.js";

export type SourceOutcome = "found" | "empty" | "skipped" | "failed";
export type SourceJoinKind = "exact" | "fuzzy";
export type GateDecision = "go" | "conditional-call" | "candidate-only" | "no-go" | "insufficient-evidence";

export interface CohortSourceCall {
  source: string;
  outcome: SourceOutcome;
  durationMs: number;
  cacheHit: boolean;
  estimatedCost: number;
  joinKind: SourceJoinKind;
  nearlyFree?: boolean;
  fuzzyCorrect?: boolean;
}

export interface CohortFieldObservation {
  field: string;
  verified: boolean;
  correct?: boolean;
  conflict?: boolean;
}

export interface AutofillCohortSampleInput {
  businessNumber: string;
  cohorts: string[];
  coverageRows: AutofillCoverageRow[];
  grantWeights?: AutofillGrantWeights;
  questionCount: number;
  unknownsResolved: number;
  sourceCalls: CohortSourceCall[];
  fields: CohortFieldObservation[];
}

export interface RatioMetric { numerator: number; denominator: number; ratio: number | null }
export interface LatencyMetric { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }

export interface CohortMetric {
  sampleCount: number;
  coverage: AutofillCoverageMetrics;
  questionCount: number;
  unknownsResolved: number;
  unknownsResolvedPerQuestion: RatioMetric;
}

export interface SourceMetric {
  attempted: number;
  skipped: number;
  outcomes: Record<SourceOutcome, number>;
  usableRate: RatioMetric;
  responseRate: RatioMetric;
  cacheHitRate: RatioMetric;
  totalLatency: LatencyMetric;
  liveLatency: LatencyMetric;
  estimatedCost: number;
  joinKind: SourceJoinKind;
  fuzzyPrecision: RatioMetric | null;
  unverifiedFuzzyResults: number;
  decision: GateDecision;
  reasons: string[];
}

export interface FieldMetric {
  verifiedCorrect: number;
  verifiedIncorrect: number;
  verifiedDenominator: number;
  accuracy: number | null;
  conflicts: number;
  unverified: number;
}

export interface AutofillCohortReport {
  schemaVersion: "autofill-cohort-measurement-v1";
  generatedAt: string;
  status: "measurement_harness_complete_sample_pending" | "initial_measurement_complete" | "stability_measurement_complete";
  sampleCount: number;
  verifiedSampleCount: number;
  thresholds: { minimumSamples: 30; stabilitySamples: 100; minimumVerifiedSamples: 3 };
  gates: { sampleReady: boolean; verificationReady: boolean; overall: "sample-pending" | "go" };
  samples: Array<{ sampleId: string; cohorts: string[] }>;
  cohorts: Record<string, CohortMetric>;
  sources: Record<string, SourceMetric>;
  fields: Record<string, FieldMetric>;
}

export function anonymizeCohortSampleId(businessNumber: string, secret: string): string {
  if (!secret) throw new Error("HMAC secret is required");
  const normalized = businessNumber.replace(/\D/g, "");
  if (!normalized) throw new Error("business number is required");
  return `sample_${createHmac("sha256", secret).update(normalized).digest("hex").slice(0, 24)}`;
}

export function buildAutofillCohortReport(input: {
  samples: readonly AutofillCohortSampleInput[];
  secret: string;
  generatedAt?: string;
}): AutofillCohortReport {
  if (!input.secret) throw new Error("HMAC secret is required");
  const sanitized = input.samples.map((sample) => ({
    sampleId: anonymizeCohortSampleId(sample.businessNumber, input.secret),
    cohorts: [...new Set(sample.cohorts.map((value) => value.trim()).filter(Boolean))],
    coverageRows: sample.coverageRows,
    ...(sample.grantWeights ? { grantWeights: sample.grantWeights } : {}),
    questionCount: nonnegative(sample.questionCount, "questionCount"),
    unknownsResolved: nonnegative(sample.unknownsResolved, "unknownsResolved"),
    sourceCalls: sample.sourceCalls,
    fields: sample.fields,
  }));
  const unique = new Map(sanitized.map((sample) => [sample.sampleId, sample]));
  if (unique.size !== sanitized.length) throw new Error("duplicate business number in cohort input");
  const samples = [...unique.values()];
  const verifiedSampleCount = samples.filter((sample) => sample.fields.some((field) => field.verified)).length;
  const sampleReady = samples.length >= 30;
  const verificationReady = verifiedSampleCount >= 3;
  const status = !sampleReady || !verificationReady
    ? "measurement_harness_complete_sample_pending"
    : samples.length >= 100 ? "stability_measurement_complete" : "initial_measurement_complete";
  const cohortNames = [...new Set(samples.flatMap((sample) => sample.cohorts))].sort();
  return {
    schemaVersion: "autofill-cohort-measurement-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    sampleCount: samples.length,
    verifiedSampleCount,
    thresholds: { minimumSamples: 30, stabilitySamples: 100, minimumVerifiedSamples: 3 },
    gates: { sampleReady, verificationReady, overall: sampleReady && verificationReady ? "go" : "sample-pending" },
    samples: samples.map(({ sampleId, cohorts }) => ({ sampleId, cohorts })),
    cohorts: Object.fromEntries(cohortNames.map((name) => [name, aggregateCohort(samples.filter((sample) => sample.cohorts.includes(name)))])),
    sources: aggregateSources(samples.flatMap((sample) => sample.sourceCalls)),
    fields: aggregateFields(samples.flatMap((sample) => sample.fields)),
  };
}

export function renderAutofillCohortMarkdown(report: AutofillCohortReport): string {
  const lines = [
    "# 사업자번호 우선 자동채움 코호트 측정", "", `> 생성 시각: ${report.generatedAt}`,
    `> 상태: ${report.status}`, "", "## 표본 gate", "",
    `- 익명 표본: ${report.sampleCount} / ${report.thresholds.minimumSamples}`,
    `- 정답 대조 표본: ${report.verifiedSampleCount} / ${report.thresholds.minimumVerifiedSamples}`,
    `- 판정: ${report.gates.overall}`, "", "## 코호트", "",
    "| 코호트 | 표본 | 권위 축 | 전체 응답 축 | 공고가중 | 질문 | 질문당 unknown 해소 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.cohorts).map(([name, value]) => `| ${escapeCell(name)} | ${value.sampleCount} | ${percent(value.coverage.authoritative_axis_coverage.ratio)} | ${percent(value.coverage.total_answered_coverage.ratio)} | ${percent(value.coverage.grant_weighted_coverage.ratio)} | ${value.questionCount} | ${decimal(value.unknownsResolvedPerQuestion.ratio)} |`),
    "", "## 소스", "", "| 소스 | 시도/스킵 | usable | response | cache | live p95 | 비용 | fuzzy precision | 판정 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...Object.entries(report.sources).map(([name, value]) => `| ${escapeCell(name)} | ${value.attempted}/${value.skipped} | ${percent(value.usableRate.ratio)} | ${percent(value.responseRate.ratio)} | ${percent(value.cacheHitRate.ratio)} | ${milliseconds(value.liveLatency.p95Ms)} | ${value.estimatedCost.toFixed(4)} | ${value.fuzzyPrecision ? percent(value.fuzzyPrecision.ratio) : "n/a"} | ${value.decision} |`),
    "", "## 필드 정확도", "", "| 필드 | verified correct/denominator | accuracy | conflicts | unverified |", "|---|---:|---:|---:|---:|",
    ...Object.entries(report.fields).map(([name, value]) => `| ${escapeCell(name)} | ${value.verifiedCorrect}/${value.verifiedDenominator} | ${percent(value.accuracy)} | ${value.conflicts} | ${value.unverified} |`), "",
  ];
  return lines.join("\n");
}

type SanitizedSample = Omit<AutofillCohortSampleInput, "businessNumber"> & { sampleId: string };

function aggregateCohort(samples: SanitizedSample[]): CohortMetric {
  const rowsByDimension = new Map<CriterionDimension, AutofillCoverageRow[]>();
  const weights: AutofillGrantWeights = {};
  for (const sample of samples) {
    for (const row of sample.coverageRows) if (row.dimension) rowsByDimension.set(row.dimension, [...(rowsByDimension.get(row.dimension) ?? []), row]);
    for (const [dimension, weight] of Object.entries(sample.grantWeights ?? {})) weights[dimension as CriterionDimension] = (weights[dimension as CriterionDimension] ?? 0) + (weight ?? 0);
  }
  const merged = [...rowsByDimension.entries()].map(([dimension, rows]) => {
    const filled = rows.filter((row) => row.axisCompleteness === "complete" && ["live", "cache", "self-declared"].includes(row.status));
    return filled.length === samples.length ? filled[0]! : { dimension, parentKey: null, status: "pending" as const, sourceKind: null, axisCompleteness: "unknown" as const };
  });
  const questionCount = samples.reduce((sum, sample) => sum + sample.questionCount, 0);
  const unknownsResolved = samples.reduce((sum, sample) => sum + sample.unknownsResolved, 0);
  return { sampleCount: samples.length, coverage: measureAutofillCoverage(merged, Object.keys(weights).length ? weights : undefined), questionCount, unknownsResolved, unknownsResolvedPerQuestion: ratio(unknownsResolved, questionCount) };
}

function aggregateSources(calls: CohortSourceCall[]): Record<string, SourceMetric> {
  return Object.fromEntries([...new Set(calls.map((call) => call.source))].sort().map((source) => {
    const values = calls.filter((call) => call.source === source);
    for (const value of values) { nonnegative(value.durationMs, "durationMs"); nonnegative(value.estimatedCost, "estimatedCost"); }
    const attemptedValues = values.filter((call) => call.outcome !== "skipped");
    const found = attemptedValues.filter((call) => call.outcome === "found").length;
    const responded = attemptedValues.filter((call) => call.outcome === "found" || call.outcome === "empty").length;
    const cached = attemptedValues.filter((call) => call.cacheHit).length;
    const verifiedFuzzy = values.filter((call) => call.joinKind === "fuzzy" && call.outcome === "found" && call.fuzzyCorrect !== undefined);
    const unverifiedFuzzyResults = values.filter((call) => call.joinKind === "fuzzy" && call.outcome === "found" && call.fuzzyCorrect === undefined).length;
    const fuzzyPrecision = values.some((call) => call.joinKind === "fuzzy") ? ratio(verifiedFuzzy.filter((call) => call.fuzzyCorrect).length, verifiedFuzzy.length) : null;
    const usableRate = ratio(found, attemptedValues.length);
    const joinKind = values.some((call) => call.joinKind === "fuzzy") ? "fuzzy" : "exact";
    const nearlyFree = values.every((call) => call.nearlyFree === true || call.estimatedCost === 0);
    const { decision, reasons } = decideSource({ joinKind, usableRate, fuzzyPrecision, nearlyFree });
    const outcomes = { found: 0, empty: 0, skipped: 0, failed: 0 };
    for (const value of values) outcomes[value.outcome] += 1;
    return [source, { attempted: attemptedValues.length, skipped: outcomes.skipped, outcomes, usableRate, responseRate: ratio(responded, attemptedValues.length), cacheHitRate: ratio(cached, attemptedValues.length), totalLatency: latency(attemptedValues.map((call) => call.durationMs)), liveLatency: latency(attemptedValues.filter((call) => !call.cacheHit).map((call) => call.durationMs)), estimatedCost: round(values.reduce((sum, call) => sum + call.estimatedCost, 0), 6), joinKind, fuzzyPrecision, unverifiedFuzzyResults, decision, reasons } satisfies SourceMetric];
  }));
}

function decideSource(input: { joinKind: SourceJoinKind; usableRate: RatioMetric; fuzzyPrecision: RatioMetric | null; nearlyFree: boolean }): Pick<SourceMetric, "decision" | "reasons"> {
  if (input.joinKind === "fuzzy") {
    if (!input.fuzzyPrecision?.denominator) return { decision: "insufficient-evidence", reasons: ["fuzzy precision has no verified denominator"] };
    if ((input.fuzzyPrecision.ratio ?? 0) < 0.95) return { decision: "candidate-only", reasons: ["fuzzy precision is below 95%"] };
    return { decision: "go", reasons: ["verified fuzzy precision is at least 95%"] };
  }
  if (!input.usableRate.denominator) return { decision: "insufficient-evidence", reasons: ["source has no attempted calls"] };
  if ((input.usableRate.ratio ?? 0) < 0.2) return input.nearlyFree
    ? { decision: "conditional-call", reasons: ["exact source yield is below 20% but cost is negligible"] }
    : { decision: "no-go", reasons: ["source yield is below 20% and no high-value exception is recorded"] };
  return { decision: "go", reasons: ["source yield is at least 20%"] };
}

function aggregateFields(fields: CohortFieldObservation[]): Record<string, FieldMetric> {
  return Object.fromEntries([...new Set(fields.map((field) => field.field))].sort().map((name) => {
    const values = fields.filter((field) => field.field === name);
    const verified = values.filter((field) => field.verified);
    const correct = verified.filter((field) => field.correct === true).length;
    const incorrect = verified.filter((field) => field.correct === false).length;
    const denominator = correct + incorrect;
    return [name, { verifiedCorrect: correct, verifiedIncorrect: incorrect, verifiedDenominator: denominator, accuracy: denominator ? correct / denominator : null, conflicts: verified.filter((field) => field.conflict === true).length, unverified: values.length - verified.length }];
  }));
}

function latency(values: number[]): LatencyMetric { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) ?? null }; }
function percentile(sorted: number[], point: number): number | null { return sorted.length ? sorted[Math.ceil(sorted.length * point) - 1]! : null; }
function ratio(numerator: number, denominator: number): RatioMetric { return { numerator, denominator, ratio: denominator ? numerator / denominator : null }; }
function nonnegative(value: number, name: string): number { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`); return value; }
function round(value: number, places: number): number { const factor = 10 ** places; return Math.round(value * factor) / factor; }
function percent(value: number | null): string { return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function decimal(value: number | null): string { return value === null ? "n/a" : value.toFixed(2); }
function milliseconds(value: number | null): string { return value === null ? "n/a" : `${value}ms`; }
function escapeCell(value: string): string { return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " "); }
