import { createHmac } from "node:crypto";
import {
  measureAutofillCoverage,
  OPERATIONAL_AUTOFILL_DIMENSIONS,
  type AutofillCoverageMetrics,
  type AutofillCoverageRow,
  type AutofillGrantWeights,
} from "../autofill/coverage.js";

export type SourceOutcome = "found" | "empty" | "skipped" | "failed";
export type SourceJoinKind = "exact" | "fuzzy";
export type GateDecision = "go" | "conditional-call" | "candidate-only" | "no-go" | "insufficient-evidence";

export const ALLOWED_COHORT_IDS = [
  "individual-general-taxable", "individual-simplified-exempt", "small-corporation",
  "dart-disclosing-corporation", "inactive-boundary",
] as const;
export type AutofillCohortId = (typeof ALLOWED_COHORT_IDS)[number];
export const ALLOWED_SOURCE_IDS = [
  "nts", "popbill", "kcomwel", "fsc", "nice", "codef", "kipris", "startup-confirmation",
  "registry", "opendart", "exact-free", "exact-paid", "fuzzy",
] as const;
export type AutofillSourceId = (typeof ALLOWED_SOURCE_IDS)[number];
export type AutofillFieldId = (typeof OPERATIONAL_AUTOFILL_DIMENSIONS)[number];
const MINIMUM_FUZZY_REVIEWED = 20;
const HMAC_DOMAIN = "cunote:autofill-cohort:v1:";

export interface CohortSourceCall {
  source: AutofillSourceId;
  outcome: SourceOutcome;
  durationMs: number;
  cacheHit: boolean;
  estimatedCost: number;
  joinKind: SourceJoinKind;
  nearlyFree?: boolean;
  fuzzyCorrect?: boolean;
}

export interface CohortFieldObservation {
  field: AutofillFieldId;
  verified: boolean;
  correct?: boolean;
  conflict?: boolean;
}

export interface AutofillCohortSampleInput {
  businessNumber: string;
  cohorts: AutofillCohortId[];
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
  status: "measurement_harness_complete_sample_pending" | "measurement_blocked" | "initial_measurement_complete" | "stability_measurement_complete";
  sampleCount: number;
  verifiedSampleCount: number;
  thresholds: { minimumSamples: 30; stabilitySamples: 100; minimumVerifiedSamples: 3 };
  gates: { sampleReady: boolean; verificationReady: boolean; sourcesReady: boolean; overall: "sample-pending" | "no-go" | "go" };
  samples: Array<{ sampleId: string; cohorts: AutofillCohortId[] }>;
  cohorts: Record<string, CohortMetric>;
  sources: Record<string, SourceMetric>;
  fields: Record<string, FieldMetric>;
}

export function anonymizeCohortSampleId(businessNumber: string, secret: string): string {
  validateSecret(secret);
  if (!/^[0-9 -]+$/.test(businessNumber)) throw new Error("business number may contain only digits, spaces, and hyphens");
  const normalized = businessNumber.replace(/[ -]/g, "");
  if (!/^\d{10}$/.test(normalized)) throw new Error("business number must contain exactly 10 digits");
  return `sample_${createHmac("sha256", secret).update(`${HMAC_DOMAIN}${normalized}`).digest("hex").slice(0, 24)}`;
}

export function buildAutofillCohortReport(input: {
  samples: readonly AutofillCohortSampleInput[];
  secret: string;
  generatedAt?: string;
}): AutofillCohortReport {
  validateSecret(input.secret);
  const sanitized = input.samples.map((sample) => ({
    sampleId: anonymizeCohortSampleId(sample.businessNumber, input.secret),
    cohorts: [...new Set(sample.cohorts.map(validateCohortId))].sort(),
    coverageRows: validateCoverageRows(sample.coverageRows),
    ...(sample.grantWeights ? { grantWeights: validateWeights(sample.grantWeights) } : {}),
    questionCount: nonnegative(sample.questionCount, "questionCount"),
    unknownsResolved: nonnegative(sample.unknownsResolved, "unknownsResolved"),
    sourceCalls: sample.sourceCalls.map(validateSourceCall),
    fields: sample.fields.map(validateField),
  }));
  const unique = new Map(sanitized.map((sample) => [sample.sampleId, sample]));
  if (unique.size !== sanitized.length) throw new Error("duplicate business number in cohort input");
  const samples = [...unique.values()].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  const verifiedSampleCount = samples.filter((sample) => sample.fields.some((field) => field.verified && typeof field.correct === "boolean")).length;
  const sampleReady = samples.length >= 30;
  const verificationReady = verifiedSampleCount >= 3;
  const cohortNames = [...new Set(samples.flatMap((sample) => sample.cohorts))].sort();
  const sources = aggregateSources(samples.flatMap((sample) => sample.sourceCalls), sampleReady && verificationReady);
  const sourcesReady = Object.values(sources).every((source) => source.decision === "go" || source.decision === "conditional-call");
  const overall = !sampleReady || !verificationReady ? "sample-pending" : sourcesReady ? "go" : "no-go";
  const status = overall === "sample-pending" ? "measurement_harness_complete_sample_pending"
    : overall === "no-go" ? "measurement_blocked"
      : samples.length >= 100 ? "stability_measurement_complete" : "initial_measurement_complete";
  return {
    schemaVersion: "autofill-cohort-measurement-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    sampleCount: samples.length,
    verifiedSampleCount,
    thresholds: { minimumSamples: 30, stabilitySamples: 100, minimumVerifiedSamples: 3 },
    gates: { sampleReady, verificationReady, sourcesReady, overall },
    samples: samples.map(({ sampleId, cohorts }) => ({ sampleId, cohorts })),
    cohorts: Object.fromEntries(cohortNames.map((name) => [name, aggregateCohort(samples.filter((sample) => sample.cohorts.includes(name)))])),
    sources,
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
  const coverages = samples.map((sample) => measureAutofillCoverage(sample.coverageRows, sample.grantWeights));
  const questionCount = samples.reduce((sum, sample) => sum + sample.questionCount, 0);
  const unknownsResolved = samples.reduce((sum, sample) => sum + sample.unknownsResolved, 0);
  return { sampleCount: samples.length, coverage: {
    authoritative_axis_coverage: sumCoverage(coverages.map((value) => value.authoritative_axis_coverage)),
    total_answered_coverage: sumCoverage(coverages.map((value) => value.total_answered_coverage)),
    grant_weighted_coverage: sumCoverage(coverages.map((value) => value.grant_weighted_coverage)),
  }, questionCount, unknownsResolved, unknownsResolvedPerQuestion: ratio(unknownsResolved, questionCount) };
}

function aggregateSources(calls: CohortSourceCall[], measurementReady: boolean): Record<string, SourceMetric> {
  return Object.fromEntries([...new Set(calls.map((call) => call.source))].sort().map((source) => {
    const values = calls.filter((call) => call.source === source).sort((left, right) => stableCallKey(left).localeCompare(stableCallKey(right)));
    for (const value of values) { nonnegative(value.durationMs, "durationMs"); nonnegative(value.estimatedCost, "estimatedCost"); }
    const attemptedValues = values.filter((call) => call.outcome !== "skipped");
    const found = attemptedValues.filter((call) => call.outcome === "found").length;
    const responded = attemptedValues.filter((call) => call.outcome === "found" || call.outcome === "empty").length;
    const cached = attemptedValues.filter((call) => call.cacheHit).length;
    const verifiedFuzzy = values.filter((call) => call.joinKind === "fuzzy" && call.outcome === "found" && call.fuzzyCorrect !== undefined);
    const unverifiedFuzzyResults = values.filter((call) => call.joinKind === "fuzzy" && call.outcome === "found" && call.fuzzyCorrect === undefined).length;
    const fuzzyPrecision = values.some((call) => call.joinKind === "fuzzy") ? ratio(verifiedFuzzy.filter((call) => call.fuzzyCorrect).length, verifiedFuzzy.length) : null;
    const usableRate = ratio(found, attemptedValues.length);
    const joinKinds = new Set(values.map((call) => call.joinKind));
    if (joinKinds.size !== 1) throw new Error(`source ${source} has inconsistent joinKind`);
    const joinKind = values[0]!.joinKind;
    const nearlyFree = values.every((call) => call.nearlyFree === true || call.estimatedCost === 0);
    const { decision, reasons } = decideSource({ joinKind, usableRate, fuzzyPrecision, nearlyFree, measurementReady });
    const outcomes = { found: 0, empty: 0, skipped: 0, failed: 0 };
    for (const value of values) outcomes[value.outcome] += 1;
    return [source, { attempted: attemptedValues.length, skipped: outcomes.skipped, outcomes, usableRate, responseRate: ratio(responded, attemptedValues.length), cacheHitRate: ratio(cached, attemptedValues.length), totalLatency: latency(attemptedValues.map((call) => call.durationMs)), liveLatency: latency(attemptedValues.filter((call) => !call.cacheHit).map((call) => call.durationMs)), estimatedCost: round(values.reduce((sum, call) => sum + call.estimatedCost, 0), 6), joinKind, fuzzyPrecision, unverifiedFuzzyResults, decision, reasons } satisfies SourceMetric];
  }));
}

function decideSource(input: { joinKind: SourceJoinKind; usableRate: RatioMetric; fuzzyPrecision: RatioMetric | null; nearlyFree: boolean; measurementReady: boolean }): Pick<SourceMetric, "decision" | "reasons"> {
  if (!input.measurementReady) return { decision: "insufficient-evidence", reasons: ["sample or verification threshold is pending"] };
  if (input.joinKind === "fuzzy") {
    if (!input.fuzzyPrecision || input.fuzzyPrecision.denominator < MINIMUM_FUZZY_REVIEWED) return { decision: "insufficient-evidence", reasons: [`fuzzy precision requires ${MINIMUM_FUZZY_REVIEWED} reviewed results`] };
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

function validateSecret(secret: string): void { if (Buffer.byteLength(secret.trim(), "utf8") < 32) throw new Error("HMAC secret must be at least 32 bytes"); }
function validateCohortId(value: AutofillCohortId): AutofillCohortId { if (!(ALLOWED_COHORT_IDS as readonly string[]).includes(value)) throw new Error("unsupported cohort ID"); return value; }
function validateSourceId(value: AutofillSourceId): AutofillSourceId { if (!(ALLOWED_SOURCE_IDS as readonly string[]).includes(value)) throw new Error("unsupported source ID"); return value; }
function validateFieldId(value: AutofillFieldId): AutofillFieldId { if (!(OPERATIONAL_AUTOFILL_DIMENSIONS as readonly string[]).includes(value)) throw new Error("unsupported field ID"); return value; }
function validateSourceCall(call: CohortSourceCall): CohortSourceCall {
  if (!call || typeof call !== "object") throw new Error("invalid source call");
  validateSourceId(call.source);
  if (!["found", "empty", "skipped", "failed"].includes(call.outcome)) throw new Error("invalid source outcome");
  if (!["exact", "fuzzy"].includes(call.joinKind)) throw new Error("invalid source joinKind");
  nonnegative(call.durationMs, "durationMs"); nonnegative(call.estimatedCost, "estimatedCost");
  if (typeof call.cacheHit !== "boolean" || (call.nearlyFree !== undefined && typeof call.nearlyFree !== "boolean") || (call.fuzzyCorrect !== undefined && typeof call.fuzzyCorrect !== "boolean")) throw new Error("invalid source call boolean");
  if (call.outcome === "skipped" && (call.cacheHit || call.durationMs !== 0 || call.estimatedCost !== 0)) throw new Error("skipped source calls cannot have cache, latency, or cost");
  if (call.fuzzyCorrect !== undefined && (call.joinKind !== "fuzzy" || call.outcome !== "found")) throw new Error("fuzzyCorrect requires a found fuzzy call");
  return call;
}
function validateField(field: CohortFieldObservation): CohortFieldObservation {
  if (!field || typeof field !== "object") throw new Error("invalid field observation"); validateFieldId(field.field);
  if (typeof field.verified !== "boolean" || (field.correct !== undefined && typeof field.correct !== "boolean") || (field.conflict !== undefined && typeof field.conflict !== "boolean")) throw new Error("invalid field observation boolean");
  if (!field.verified && (field.correct !== undefined || field.conflict !== undefined)) throw new Error("unverified field cannot declare correctness or conflict");
  return field;
}
function validateCoverageRows(rows: AutofillCoverageRow[]): AutofillCoverageRow[] {
  if (!Array.isArray(rows)) throw new Error("coverageRows must be an array");
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("invalid coverage row");
    if (row.dimension !== null) validateFieldId(row.dimension as AutofillFieldId);
    if (row.parentKey !== null && typeof row.parentKey !== "string") throw new Error("invalid coverage parentKey");
    if (!["self-declared", "pending", "live", "cache", "failed", "n/a"].includes(row.status)) throw new Error("invalid coverage status");
    if (row.sourceKind !== null && !["authoritative_api", "public_registry", "auth_supplied", "self_declared", "derived"].includes(row.sourceKind)) throw new Error("invalid coverage sourceKind");
    if (!["complete", "partial", "unknown", "not_applicable"].includes(row.axisCompleteness)) throw new Error("invalid axisCompleteness");
  }
  return rows;
}
function validateWeights(weights: AutofillGrantWeights): AutofillGrantWeights { for (const [key, value] of Object.entries(weights)) { validateFieldId(key as AutofillFieldId); nonnegative(value ?? 0, "grantWeight"); } return weights; }
function sumCoverage(values: Array<{ numerator: number; denominator: number }>): { numerator: number; denominator: number; ratio: number } { const numerator = values.reduce((sum, value) => sum + value.numerator, 0); const denominator = values.reduce((sum, value) => sum + value.denominator, 0); return { numerator, denominator, ratio: denominator ? numerator / denominator : 0 }; }
function stableCallKey(call: CohortSourceCall): string { return [call.outcome, call.joinKind, call.durationMs, call.estimatedCost, Number(call.cacheHit), String(call.fuzzyCorrect), String(call.nearlyFree)].join("|"); }
