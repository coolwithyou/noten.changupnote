import { createHash } from "node:crypto";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";

export const GRANT_ANALYSIS_EVALUATION_STATES = [
  "condition_present",
  "explicit_no_condition",
  "unknown",
  "unresolved",
] as const;
export type GrantAnalysisEvaluationState =
  (typeof GRANT_ANALYSIS_EVALUATION_STATES)[number];

export const GRANT_ANALYSIS_EVALUATION_RESERVED_AXES = [
  "premises",
  "export_performance",
] as const satisfies readonly CriterionDimension[];

export const GRANT_ANALYSIS_EVALUATION_AXES = [...CRITERION_DIMENSIONS] as const;

export type GrantAnalysisEvaluationArtifactKind = "raw_api" | "attachment_markdown";
export type GrantAnalysisEvaluationLocatorKind = "page" | "paragraph";
export type GrantAnalysisEvaluationJudgeId = "judge_1" | "judge_2" | "judge_3";

export interface GrantAnalysisEvaluationInputBlock {
  artifactId: string;
  kind: GrantAnalysisEvaluationArtifactKind;
  locatorKind: GrantAnalysisEvaluationLocatorKind;
  locator: string;
  text: string;
  expected: boolean;
  included: boolean;
  unreadReason?: string | null;
  truncated?: boolean;
}

/** Raw-only packet. It intentionally has no candidate, score, match, or reveal fields. */
export interface GrantAnalysisEvaluationJudgePacket {
  recordType: "grant_analysis_evaluation_raw_judge_packet";
  schemaVersion: 1;
  grantKey: string;
  sourceRevision: string;
  blocks: readonly GrantAnalysisEvaluationInputBlock[];
  inputOrder: readonly string[];
  inputLimitsSha256: string;
}

export interface GrantAnalysisEvaluationEvidence {
  artifactId: string;
  locatorKind: GrantAnalysisEvaluationLocatorKind;
  locator: string;
  quote: string;
}

export interface GrantAnalysisEvaluationAxisJudgment {
  dimension: CriterionDimension;
  state: GrantAnalysisEvaluationState;
  normalizedCondition: unknown | null;
  evidence: readonly GrantAnalysisEvaluationEvidence[];
  confidence: number;
  exceptions: readonly string[];
  logicalRelation: "and" | "or" | "mixed" | "not_applicable" | "unknown";
  applicablePeriod: string | null;
  note: string;
}

export interface GrantAnalysisEvaluationJudgeLedger {
  recordType: "grant_analysis_evaluation_judge_ledger";
  schemaVersion: 1;
  judgeId: GrantAnalysisEvaluationJudgeId;
  grantKey: string;
  sourceRevision: string;
  truncated: boolean;
  schemaRecovered: boolean;
  axes: readonly GrantAnalysisEvaluationAxisJudgment[];
}

export interface GrantAnalysisEvaluationProxyAxis {
  dimension: CriterionDimension;
  state: GrantAnalysisEvaluationState;
  inspectable: boolean;
  includedInQualityDenominator: boolean;
  judgment: GrantAnalysisEvaluationAxisJudgment | null;
  resolution: "judge_1_2_agreement" | "judge_3" | "unresolved";
}

export interface GrantAnalysisEvaluationConsensus {
  grantKey: string;
  sourceRevision: string;
  disagreementAxes: readonly CriterionDimension[];
  judge3EligibleAxes: readonly CriterionDimension[];
  axes: readonly GrantAnalysisEvaluationProxyAxis[];
}

export interface GrantAnalysisEvaluationQualityDenominator {
  totalAxes: 22;
  inspectableAxes: 20;
  reservedAxes: 2;
  confirmedInspectableAxes: number;
  unresolvedInspectableAxes: number;
}

const AXIS_SET = new Set<string>(GRANT_ANALYSIS_EVALUATION_AXES);
const RESERVED_SET = new Set<CriterionDimension>(GRANT_ANALYSIS_EVALUATION_RESERVED_AXES);

export function isGrantAnalysisEvaluationReservedAxis(
  dimension: CriterionDimension,
): boolean {
  return RESERVED_SET.has(dimension);
}

export function validateGrantAnalysisEvaluationJudgeLedger(
  ledger: GrantAnalysisEvaluationJudgeLedger,
  expectedJudge?: GrantAnalysisEvaluationJudgeId,
): GrantAnalysisEvaluationJudgeLedger {
  if (expectedJudge && ledger.judgeId !== expectedJudge) {
    throw new Error(`Expected ${expectedJudge}, received ${ledger.judgeId}.`);
  }
  assertNonEmpty(ledger.grantKey, "grantKey");
  assertNonEmpty(ledger.sourceRevision, "sourceRevision");
  const byDimension = new Map<CriterionDimension, GrantAnalysisEvaluationAxisJudgment>();
  for (const axis of ledger.axes) {
    if (!AXIS_SET.has(axis.dimension)) {
      throw new Error(`Unknown evaluation axis: ${String(axis.dimension)}.`);
    }
    if (byDimension.has(axis.dimension)) {
      throw new Error(`Duplicate evaluation axis: ${axis.dimension}.`);
    }
    if (!GRANT_ANALYSIS_EVALUATION_STATES.includes(axis.state)) {
      throw new Error(`Invalid state for ${axis.dimension}: ${String(axis.state)}.`);
    }
    if (!Number.isFinite(axis.confidence) || axis.confidence < 0 || axis.confidence > 1) {
      throw new Error(`${axis.dimension}: confidence must be between 0 and 1.`);
    }
    if (axis.state === "condition_present" && axis.normalizedCondition === null) {
      throw new Error(`${axis.dimension}: condition_present requires normalizedCondition.`);
    }
    if (axis.state !== "condition_present" && axis.normalizedCondition !== null) {
      throw new Error(`${axis.dimension}: non-condition state cannot carry normalizedCondition.`);
    }
    byDimension.set(axis.dimension, canonicalAxis(axis));
  }
  const missing = GRANT_ANALYSIS_EVALUATION_AXES.filter((axis) => !byDimension.has(axis));
  if (missing.length > 0 || byDimension.size !== GRANT_ANALYSIS_EVALUATION_AXES.length) {
    throw new Error(`Judge ledger must contain all 22 axes exactly once; missing: ${missing.join(", ") || "none"}.`);
  }
  return {
    ...ledger,
    grantKey: ledger.grantKey.trim(),
    sourceRevision: ledger.sourceRevision.trim(),
    axes: GRANT_ANALYSIS_EVALUATION_AXES.map((axis) => byDimension.get(axis)!),
  };
}

/**
 * Produces deterministic proxy gold. Judge 3 may address only Judge 1/2
 * disagreements; any omitted or unresolved adjudication remains unresolved.
 */
export function buildGrantAnalysisEvaluationConsensus(options: {
  judge1: GrantAnalysisEvaluationJudgeLedger;
  judge2: GrantAnalysisEvaluationJudgeLedger;
  judge3?: GrantAnalysisEvaluationJudgeLedger | null;
}): GrantAnalysisEvaluationConsensus {
  const judge1 = validateGrantAnalysisEvaluationJudgeLedger(options.judge1, "judge_1");
  const judge2 = validateGrantAnalysisEvaluationJudgeLedger(options.judge2, "judge_2");
  assertSameJudgeUniverse(judge1, judge2);
  const judge1ByAxis = new Map(judge1.axes.map((axis) => [axis.dimension, axis]));
  const judge2ByAxis = new Map(judge2.axes.map((axis) => [axis.dimension, axis]));
  const disagreementAxes = GRANT_ANALYSIS_EVALUATION_AXES.filter((dimension) =>
    semanticJudgmentKey(judge1ByAxis.get(dimension)!) !==
    semanticJudgmentKey(judge2ByAxis.get(dimension)!));
  const disagreementSet = new Set<CriterionDimension>(disagreementAxes);

  let judge3ByAxis = new Map<CriterionDimension, GrantAnalysisEvaluationAxisJudgment>();
  if (options.judge3) {
    const judge3 = validatePartialJudge3(options.judge3, judge1, disagreementSet);
    judge3ByAxis = new Map(judge3.axes.map((axis) => [axis.dimension, axis]));
  }

  const axes = GRANT_ANALYSIS_EVALUATION_AXES.map((dimension) => {
    const inspectable = !isGrantAnalysisEvaluationReservedAxis(dimension);
    if (!disagreementSet.has(dimension)) {
      const judgment = judge1ByAxis.get(dimension)!;
      return {
        dimension,
        state: judgment.state,
        inspectable,
        includedInQualityDenominator: inspectable,
        judgment,
        resolution: judgment.state === "unresolved" ? "unresolved" : "judge_1_2_agreement",
      } satisfies GrantAnalysisEvaluationProxyAxis;
    }
    const adjudication = judge3ByAxis.get(dimension);
    if (!adjudication || adjudication.state === "unresolved") {
      return {
        dimension,
        state: "unresolved",
        inspectable,
        includedInQualityDenominator: inspectable,
        judgment: adjudication ?? null,
        resolution: "unresolved",
      } satisfies GrantAnalysisEvaluationProxyAxis;
    }
    return {
      dimension,
      state: adjudication.state,
      inspectable,
      includedInQualityDenominator: inspectable,
      judgment: adjudication,
      resolution: "judge_3",
    } satisfies GrantAnalysisEvaluationProxyAxis;
  });

  return {
    grantKey: judge1.grantKey,
    sourceRevision: judge1.sourceRevision,
    disagreementAxes,
    judge3EligibleAxes: disagreementAxes,
    axes,
  };
}

export function grantAnalysisEvaluationQualityDenominator(
  consensus: GrantAnalysisEvaluationConsensus,
): GrantAnalysisEvaluationQualityDenominator {
  const inspectable = consensus.axes.filter((axis) => axis.includedInQualityDenominator);
  return {
    totalAxes: 22,
    inspectableAxes: 20,
    reservedAxes: 2,
    confirmedInspectableAxes: inspectable.filter((axis) => axis.state !== "unresolved").length,
    unresolvedInspectableAxes: inspectable.filter((axis) => axis.state === "unresolved").length,
  };
}

export function semanticGrantAnalysisJudgmentSha256(
  judgment: GrantAnalysisEvaluationAxisJudgment,
): string {
  return createHash("sha256").update(semanticJudgmentKey(judgment)).digest("hex");
}

function validatePartialJudge3(
  raw: GrantAnalysisEvaluationJudgeLedger,
  reference: GrantAnalysisEvaluationJudgeLedger,
  eligible: ReadonlySet<CriterionDimension>,
): GrantAnalysisEvaluationJudgeLedger {
  if (raw.judgeId !== "judge_3") throw new Error(`Expected judge_3, received ${raw.judgeId}.`);
  assertSameJudgeUniverse(reference, raw);
  const seen = new Set<CriterionDimension>();
  const axes = raw.axes.map((axis) => {
    if (!AXIS_SET.has(axis.dimension)) throw new Error(`Unknown evaluation axis: ${String(axis.dimension)}.`);
    if (!eligible.has(axis.dimension)) {
      throw new Error(`Judge 3 is not eligible for agreed axis ${axis.dimension}.`);
    }
    if (seen.has(axis.dimension)) throw new Error(`Duplicate Judge 3 axis: ${axis.dimension}.`);
    seen.add(axis.dimension);
    if (!GRANT_ANALYSIS_EVALUATION_STATES.includes(axis.state)) {
      throw new Error(`Invalid Judge 3 state for ${axis.dimension}.`);
    }
    if (!Number.isFinite(axis.confidence) || axis.confidence < 0 || axis.confidence > 1) {
      throw new Error(`${axis.dimension}: confidence must be between 0 and 1.`);
    }
    if (axis.state === "condition_present" && axis.normalizedCondition === null) {
      throw new Error(`${axis.dimension}: condition_present requires normalizedCondition.`);
    }
    if (axis.state !== "condition_present" && axis.normalizedCondition !== null) {
      throw new Error(`${axis.dimension}: non-condition state cannot carry normalizedCondition.`);
    }
    return canonicalAxis(axis);
  });
  return { ...raw, axes };
}

function assertSameJudgeUniverse(
  left: Pick<GrantAnalysisEvaluationJudgeLedger, "grantKey" | "sourceRevision">,
  right: Pick<GrantAnalysisEvaluationJudgeLedger, "grantKey" | "sourceRevision">,
): void {
  if (left.grantKey !== right.grantKey || left.sourceRevision !== right.sourceRevision) {
    throw new Error("Judge ledgers must use the same grantKey and sourceRevision.");
  }
}

function semanticJudgmentKey(judgment: GrantAnalysisEvaluationAxisJudgment): string {
  return stableStringify({
    state: judgment.state,
    normalizedCondition: judgment.normalizedCondition,
    exceptions: [...judgment.exceptions].map(normalizeText).sort(),
    logicalRelation: judgment.logicalRelation,
    applicablePeriod: judgment.applicablePeriod ? normalizeText(judgment.applicablePeriod) : null,
  });
}

function canonicalAxis(
  axis: GrantAnalysisEvaluationAxisJudgment,
): GrantAnalysisEvaluationAxisJudgment {
  return {
    ...axis,
    normalizedCondition: axis.normalizedCondition === null
      ? null
      : canonicalJsonValue(axis.normalizedCondition),
    exceptions: [...axis.exceptions].map((value) => value.trim()).filter(Boolean),
    applicablePeriod: axis.applicablePeriod?.trim() || null,
    note: axis.note.trim(),
    evidence: axis.evidence.map((evidence) => ({
      ...evidence,
      artifactId: evidence.artifactId.trim(),
      locator: evidence.locator.trim(),
      quote: evidence.quote.trim(),
    })),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  }
  return value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}
