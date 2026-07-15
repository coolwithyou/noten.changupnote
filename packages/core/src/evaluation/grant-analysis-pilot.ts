import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type GrantCriterion,
} from "@cunote/contracts";

export const GRANT_ANALYSIS_PILOT_VARIANTS = ["A", "B", "C"] as const;
export type GrantAnalysisPilotVariantId = (typeof GRANT_ANALYSIS_PILOT_VARIANTS)[number];

export const GRANT_ANALYSIS_AXIS_STATES = [
  "structured",
  "explicit_no_condition",
  "text_only",
  "evidence_missing",
  "not_inspected",
  "failed",
  "reserved",
] as const;
export type GrantAnalysisAxisState = (typeof GRANT_ANALYSIS_AXIS_STATES)[number];

export const GRANT_ANALYSIS_RESERVED_DIMENSIONS = [
  "premises",
  "export_performance",
] as const satisfies readonly CriterionDimension[];

export const GRANT_ANALYSIS_CATCH_ALL_DIMENSION = "other" as const satisfies CriterionDimension;

export type GrantAnalysisAxisRole = "criterion" | "reserved" | "catch_all";
export type GrantAnalysisInputKind = "api_text" | "attachment";

/**
 * One expected input in the frozen pilot universe.
 *
 * `fetched`, `converted`, and `included` are deliberately separate: a stored
 * attachment is not proof that the extractor could read it, and converted text
 * is not proof that it reached the model input.
 */
export interface GrantAnalysisInputArtifact {
  inputId: string;
  kind: GrantAnalysisInputKind;
  fetched: boolean;
  converted: boolean;
  included: boolean;
  failure?: string | null;
}

export interface GrantAnalysisAxisAssessmentInput {
  dimension: CriterionDimension;
  state: GrantAnalysisAxisState;
  criteria: readonly GrantCriterion[];
  note?: string | null;
}

export interface GrantAnalysisAxisAssessment extends GrantAnalysisAxisAssessmentInput {
  role: GrantAnalysisAxisRole;
  criteria: readonly GrantCriterion[];
  note?: string;
}

export interface GrantAnalysisPilotVariantInput {
  variant: GrantAnalysisPilotVariantId;
  grantId: string;
  sourceRevision: string;
  extractorVersion: string;
  inputs: readonly GrantAnalysisInputArtifact[];
  axes: readonly GrantAnalysisAxisAssessmentInput[];
}

export interface GrantAnalysisPilotVariant {
  variant: GrantAnalysisPilotVariantId;
  grantId: string;
  sourceRevision: string;
  extractorVersion: string;
  inputs: readonly GrantAnalysisInputArtifact[];
  axes: readonly GrantAnalysisAxisAssessment[];
}

export interface GrantAnalysisInputCoverage {
  expected: number;
  fetched: number;
  converted: number;
  included: number;
  failed: number;
  fetchCoverage: number | null;
  conversionCoverage: number | null;
  inclusionCoverage: number | null;
}

export interface GrantAnalysisAxisCoverage {
  total: number;
  inspectable: number;
  reserved: number;
  attempted: number;
  inspected: number;
  resolved: number;
  failed: number;
  notInspected: number;
  inspectionCoverage: number | null;
  resolutionCoverage: number | null;
  stateCounts: Record<GrantAnalysisAxisState, number>;
}

export interface GrantAnalysisEvidenceCoverage {
  criteria: number;
  evidenceBacked: number;
  missing: number;
  coverage: number | null;
}

export interface GrantAnalysisPilotSummary {
  input: GrantAnalysisInputCoverage & {
    byKind: Record<GrantAnalysisInputKind, GrantAnalysisInputCoverage>;
  };
  axes: GrantAnalysisAxisCoverage;
  evidence: GrantAnalysisEvidenceCoverage;
}

export interface GrantAnalysisVariantValues<T> {
  A: T;
  B: T;
  C: T;
}

export interface GrantAnalysisCriterionDeltaEntry {
  key: string;
  beforeCount: number;
  afterCount: number;
  beforeEvidenceBacked: number;
  afterEvidenceBacked: number;
}

export interface GrantAnalysisCriterionDelta {
  added: number;
  removed: number;
  retained: number;
  evidenceGained: number;
  evidenceLost: number;
  changed: readonly GrantAnalysisCriterionDeltaEntry[];
}

export interface GrantAnalysisAxisComparison {
  dimension: CriterionDimension;
  role: GrantAnalysisAxisRole;
  states: GrantAnalysisVariantValues<GrantAnalysisAxisState>;
  criterionCounts: GrantAnalysisVariantValues<number>;
  evidenceBackedCriterionCounts: GrantAnalysisVariantValues<number>;
  deltas: {
    AtoB: GrantAnalysisCriterionDelta;
    BtoC: GrantAnalysisCriterionDelta;
    AtoC: GrantAnalysisCriterionDelta;
  };
}

export interface GrantAnalysisTransitionSummary {
  axisStateChanges: number;
  newlyInspected: number;
  newlyResolved: number;
  regressions: number;
  criteriaAdded: number;
  criteriaRemoved: number;
  evidenceGained: number;
  evidenceLost: number;
}

export interface GrantAnalysisPilotComparison {
  grantId: string;
  sourceRevision: string;
  summaries: GrantAnalysisVariantValues<GrantAnalysisPilotSummary>;
  axes: readonly GrantAnalysisAxisComparison[];
  transitions: {
    AtoB: GrantAnalysisTransitionSummary;
    BtoC: GrantAnalysisTransitionSummary;
    AtoC: GrantAnalysisTransitionSummary;
  };
}

const RESERVED_DIMENSION_SET = new Set<CriterionDimension>(GRANT_ANALYSIS_RESERVED_DIMENSIONS);
const DIMENSION_SET = new Set<string>(CRITERION_DIMENSIONS);

/** Validate and canonicalize one frozen A/B/C grant-analysis result. */
export function createGrantAnalysisPilotVariant(
  input: GrantAnalysisPilotVariantInput,
): GrantAnalysisPilotVariant {
  assertNonEmpty(input.grantId, "grantId");
  assertNonEmpty(input.sourceRevision, "sourceRevision");
  assertNonEmpty(input.extractorVersion, "extractorVersion");
  if (!GRANT_ANALYSIS_PILOT_VARIANTS.includes(input.variant)) {
    throw new Error(`invalid pilot variant: ${String(input.variant)}`);
  }

  const inputs = validateInputs(input.inputs);
  const axes = validateAxes(input.axes);

  return {
    variant: input.variant,
    grantId: input.grantId.trim(),
    sourceRevision: input.sourceRevision.trim(),
    extractorVersion: input.extractorVersion.trim(),
    inputs,
    axes,
  };
}

export function grantAnalysisAxisRole(dimension: CriterionDimension): GrantAnalysisAxisRole {
  if (RESERVED_DIMENSION_SET.has(dimension)) return "reserved";
  if (dimension === GRANT_ANALYSIS_CATCH_ALL_DIMENSION) return "catch_all";
  return "criterion";
}

/** Structured evidence follows the existing contract: a quote or a source locator. */
export function grantAnalysisCriterionHasEvidence(criterion: GrantCriterion): boolean {
  return Boolean(cleanText(criterion.source_span) ?? cleanText(criterion.source_field));
}

export function summarizeGrantAnalysisPilotVariant(
  variant: GrantAnalysisPilotVariant,
): GrantAnalysisPilotSummary {
  const input = inputCoverage(variant.inputs);
  const stateCounts = emptyStateCounts();
  let inspected = 0;
  let resolved = 0;
  let attempted = 0;
  let failed = 0;
  let notInspected = 0;

  for (const axis of variant.axes) {
    stateCounts[axis.state] += 1;
    if (axis.state === "reserved") continue;
    if (axis.state !== "not_inspected") attempted += 1;
    if (isInspectedState(axis.state)) inspected += 1;
    if (isResolvedState(axis.state)) resolved += 1;
    if (axis.state === "failed") failed += 1;
    if (axis.state === "not_inspected") notInspected += 1;
  }

  const criteria = variant.axes.flatMap((axis) => axis.criteria);
  const evidenceBacked = criteria.filter(grantAnalysisCriterionHasEvidence).length;
  const inspectable = CRITERION_DIMENSIONS.length - GRANT_ANALYSIS_RESERVED_DIMENSIONS.length;

  return {
    input: {
      ...input,
      byKind: {
        api_text: inputCoverage(variant.inputs.filter((entry) => entry.kind === "api_text")),
        attachment: inputCoverage(variant.inputs.filter((entry) => entry.kind === "attachment")),
      },
    },
    axes: {
      total: CRITERION_DIMENSIONS.length,
      inspectable,
      reserved: GRANT_ANALYSIS_RESERVED_DIMENSIONS.length,
      attempted,
      inspected,
      resolved,
      failed,
      notInspected,
      inspectionCoverage: ratio(inspected, inspectable),
      resolutionCoverage: ratio(resolved, inspectable),
      stateCounts,
    },
    evidence: {
      criteria: criteria.length,
      evidenceBacked,
      missing: criteria.length - evidenceBacked,
      coverage: ratio(evidenceBacked, criteria.length),
    },
  };
}

/**
 * Compare a fixed grant revision across current extraction (A), API-only
 * re-extraction (B), and API-plus-attachment extraction (C).
 */
export function compareGrantAnalysisPilotVariants(
  rawVariants: readonly GrantAnalysisPilotVariantInput[],
): GrantAnalysisPilotComparison {
  const variants = canonicalVariants(rawVariants);
  assertComparableVariants(variants);

  const summaries = variantValues(
    summarizeGrantAnalysisPilotVariant(variants.A),
    summarizeGrantAnalysisPilotVariant(variants.B),
    summarizeGrantAnalysisPilotVariant(variants.C),
  );
  const axes = CRITERION_DIMENSIONS.map((dimension) => {
    const A = axisFor(variants.A, dimension);
    const B = axisFor(variants.B, dimension);
    const C = axisFor(variants.C, dimension);
    return {
      dimension,
      role: grantAnalysisAxisRole(dimension),
      states: variantValues(A.state, B.state, C.state),
      criterionCounts: variantValues(A.criteria.length, B.criteria.length, C.criteria.length),
      evidenceBackedCriterionCounts: variantValues(
        evidenceCount(A.criteria),
        evidenceCount(B.criteria),
        evidenceCount(C.criteria),
      ),
      deltas: {
        AtoB: compareCriteria(A.criteria, B.criteria),
        BtoC: compareCriteria(B.criteria, C.criteria),
        AtoC: compareCriteria(A.criteria, C.criteria),
      },
    } satisfies GrantAnalysisAxisComparison;
  });

  return {
    grantId: variants.A.grantId,
    sourceRevision: variants.A.sourceRevision,
    summaries,
    axes,
    transitions: {
      AtoB: transitionSummary(variants.A, variants.B),
      BtoC: transitionSummary(variants.B, variants.C),
      AtoC: transitionSummary(variants.A, variants.C),
    },
  };
}

/** Stable semantic identity; extractor metadata and evidence are intentionally excluded. */
export function grantAnalysisCriterionKey(criterion: GrantCriterion): string {
  return stableStringify({
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
  });
}

function validateInputs(inputs: readonly GrantAnalysisInputArtifact[]): GrantAnalysisInputArtifact[] {
  if (!Array.isArray(inputs)) throw new Error("inputs must be an array");
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    const location = `inputs[${index}]`;
    assertNonEmpty(input.inputId, `${location}.inputId`);
    if (input.kind !== "api_text" && input.kind !== "attachment") {
      throw new Error(`${location}.kind must be api_text or attachment`);
    }
    const key = inputKey(input);
    if (seen.has(key)) throw new Error(`duplicate pilot input: ${key}`);
    seen.add(key);
    if (input.converted && !input.fetched) {
      throw new Error(`${location}: converted input must be fetched`);
    }
    if (input.included && !input.converted) {
      throw new Error(`${location}: included input must be converted`);
    }
    const failure = cleanText(input.failure);
    if (input.failure !== undefined && input.failure !== null && !failure) {
      throw new Error(`${location}.failure must be non-empty when present`);
    }
    if (failure && input.included) {
      throw new Error(`${location}: failed input cannot be included`);
    }
    return {
      inputId: input.inputId.trim(),
      kind: input.kind,
      fetched: input.fetched,
      converted: input.converted,
      included: input.included,
      ...(failure ? { failure } : {}),
    };
  });
}

function validateAxes(axes: readonly GrantAnalysisAxisAssessmentInput[]): GrantAnalysisAxisAssessment[] {
  if (!Array.isArray(axes)) throw new Error("axes must be an array");
  const byDimension = new Map<CriterionDimension, GrantAnalysisAxisAssessmentInput>();

  for (const [index, axis] of axes.entries()) {
    if (!DIMENSION_SET.has(String(axis.dimension))) {
      throw new Error(`axes[${index}]: invalid dimension ${String(axis.dimension)}`);
    }
    if (byDimension.has(axis.dimension)) {
      throw new Error(`duplicate axis assessment: ${axis.dimension}`);
    }
    byDimension.set(axis.dimension, axis);
  }

  const missing = CRITERION_DIMENSIONS.filter((dimension) => !byDimension.has(dimension));
  if (missing.length > 0 || axes.length !== CRITERION_DIMENSIONS.length) {
    throw new Error(`axis assessments must contain every criterion dimension exactly once; missing: ${missing.join(", ") || "none"}`);
  }

  return CRITERION_DIMENSIONS.map((dimension) => validateAxis(byDimension.get(dimension) as GrantAnalysisAxisAssessmentInput));
}

function validateAxis(axis: GrantAnalysisAxisAssessmentInput): GrantAnalysisAxisAssessment {
  if (!GRANT_ANALYSIS_AXIS_STATES.includes(axis.state)) {
    throw new Error(`${axis.dimension}: invalid state ${String(axis.state)}`);
  }
  if (!Array.isArray(axis.criteria)) throw new Error(`${axis.dimension}: criteria must be an array`);

  const role = grantAnalysisAxisRole(axis.dimension);
  if (role === "reserved" && axis.state !== "reserved") {
    throw new Error(`${axis.dimension}: reserved dimension must use reserved state`);
  }
  if (role !== "reserved" && axis.state === "reserved") {
    throw new Error(`${axis.dimension}: only premises and export_performance may be reserved`);
  }

  const criteria = axis.criteria.map((criterion, index) => {
    if (criterion.dimension !== axis.dimension) {
      throw new Error(`${axis.dimension}.criteria[${index}]: criterion dimension must match its axis`);
    }
    return { ...criterion };
  });
  const note = cleanText(axis.note);

  if (axis.state === "structured") {
    requireCriteria(axis.dimension, criteria);
    if (criteria.some((criterion) => criterion.operator === "text_only")) {
      throw new Error(`${axis.dimension}: structured state cannot contain text_only criteria`);
    }
    if (criteria.some((criterion) => !grantAnalysisCriterionHasEvidence(criterion))) {
      throw new Error(`${axis.dimension}: structured criteria must be evidence-backed`);
    }
  } else if (axis.state === "text_only") {
    requireCriteria(axis.dimension, criteria);
    if (!criteria.some((criterion) => criterion.operator === "text_only")) {
      throw new Error(`${axis.dimension}: text_only state requires a text_only criterion`);
    }
    if (criteria.some((criterion) => !grantAnalysisCriterionHasEvidence(criterion))) {
      throw new Error(`${axis.dimension}: text_only criteria must be evidence-backed`);
    }
  } else if (axis.state === "evidence_missing") {
    requireCriteria(axis.dimension, criteria);
    if (criteria.some((criterion) => criterion.operator === "text_only")) {
      throw new Error(`${axis.dimension}: evidence_missing state cannot contain text_only criteria`);
    }
    if (criteria.every(grantAnalysisCriterionHasEvidence)) {
      throw new Error(`${axis.dimension}: evidence_missing state requires at least one criterion without evidence`);
    }
  } else if (criteria.length > 0) {
    throw new Error(`${axis.dimension}: ${axis.state} state cannot contain criteria`);
  }

  if (axis.state === "failed" && !note) {
    throw new Error(`${axis.dimension}: failed state requires a note`);
  }

  return {
    dimension: axis.dimension,
    state: axis.state,
    role,
    criteria,
    ...(note ? { note } : {}),
  };
}

function requireCriteria(dimension: CriterionDimension, criteria: readonly GrantCriterion[]): void {
  if (criteria.length === 0) throw new Error(`${dimension}: assessment state requires at least one criterion`);
}

function canonicalVariants(
  rawVariants: readonly GrantAnalysisPilotVariantInput[],
): GrantAnalysisVariantValues<GrantAnalysisPilotVariant> {
  if (!Array.isArray(rawVariants)) throw new Error("pilot variants must be an array");
  const byVariant = new Map<GrantAnalysisPilotVariantId, GrantAnalysisPilotVariant>();
  for (const raw of rawVariants) {
    const variant = createGrantAnalysisPilotVariant(raw);
    if (byVariant.has(variant.variant)) throw new Error(`duplicate pilot variant: ${variant.variant}`);
    byVariant.set(variant.variant, variant);
  }
  const missing = GRANT_ANALYSIS_PILOT_VARIANTS.filter((variant) => !byVariant.has(variant));
  if (missing.length > 0 || rawVariants.length !== GRANT_ANALYSIS_PILOT_VARIANTS.length) {
    throw new Error(`comparison requires A, B, and C exactly once; missing: ${missing.join(", ") || "none"}`);
  }
  return variantValues(
    byVariant.get("A") as GrantAnalysisPilotVariant,
    byVariant.get("B") as GrantAnalysisPilotVariant,
    byVariant.get("C") as GrantAnalysisPilotVariant,
  );
}

function assertComparableVariants(variants: GrantAnalysisVariantValues<GrantAnalysisPilotVariant>): void {
  if (variants.B.grantId !== variants.A.grantId || variants.C.grantId !== variants.A.grantId) {
    throw new Error("A/B/C comparison requires the same grantId");
  }
  if (variants.B.sourceRevision !== variants.A.sourceRevision || variants.C.sourceRevision !== variants.A.sourceRevision) {
    throw new Error("A/B/C comparison requires the same sourceRevision");
  }
  const expectedInputs = inputUniverse(variants.A.inputs);
  if (inputUniverse(variants.B.inputs) !== expectedInputs || inputUniverse(variants.C.inputs) !== expectedInputs) {
    throw new Error("A/B/C comparison requires the same expected input universe");
  }
}

function inputUniverse(inputs: readonly GrantAnalysisInputArtifact[]): string {
  return inputs.map(inputKey).sort().join("\n");
}

function inputKey(input: Pick<GrantAnalysisInputArtifact, "kind" | "inputId">): string {
  return `${input.kind}:${input.inputId.trim()}`;
}

function inputCoverage(inputs: readonly GrantAnalysisInputArtifact[]): GrantAnalysisInputCoverage {
  const expected = inputs.length;
  const fetched = inputs.filter((input) => input.fetched).length;
  const converted = inputs.filter((input) => input.converted).length;
  const included = inputs.filter((input) => input.included).length;
  const failed = inputs.filter((input) => Boolean(cleanText(input.failure))).length;
  return {
    expected,
    fetched,
    converted,
    included,
    failed,
    fetchCoverage: ratio(fetched, expected),
    conversionCoverage: ratio(converted, expected),
    inclusionCoverage: ratio(included, expected),
  };
}

function emptyStateCounts(): Record<GrantAnalysisAxisState, number> {
  return {
    structured: 0,
    explicit_no_condition: 0,
    text_only: 0,
    evidence_missing: 0,
    not_inspected: 0,
    failed: 0,
    reserved: 0,
  };
}

function isInspectedState(state: GrantAnalysisAxisState): boolean {
  return state === "structured" ||
    state === "explicit_no_condition" ||
    state === "text_only" ||
    state === "evidence_missing";
}

function isResolvedState(state: GrantAnalysisAxisState): boolean {
  return state === "structured" || state === "explicit_no_condition";
}

function axisFor(
  variant: GrantAnalysisPilotVariant,
  dimension: CriterionDimension,
): GrantAnalysisAxisAssessment {
  const axis = variant.axes.find((entry) => entry.dimension === dimension);
  if (!axis) throw new Error(`${variant.variant}: missing axis ${dimension}`);
  return axis;
}

function evidenceCount(criteria: readonly GrantCriterion[]): number {
  return criteria.filter(grantAnalysisCriterionHasEvidence).length;
}

function compareCriteria(
  before: readonly GrantCriterion[],
  after: readonly GrantCriterion[],
): GrantAnalysisCriterionDelta {
  const beforeGroups = criterionGroups(before);
  const afterGroups = criterionGroups(after);
  const keys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();
  let added = 0;
  let removed = 0;
  let retained = 0;
  let evidenceGained = 0;
  let evidenceLost = 0;
  const changed: GrantAnalysisCriterionDeltaEntry[] = [];

  for (const key of keys) {
    const left = beforeGroups.get(key) ?? { count: 0, evidenceBacked: 0 };
    const right = afterGroups.get(key) ?? { count: 0, evidenceBacked: 0 };
    const retainedForKey = Math.min(left.count, right.count);
    const leftRetainedEvidence = Math.min(left.evidenceBacked, retainedForKey);
    const rightRetainedEvidence = Math.min(right.evidenceBacked, retainedForKey);
    added += Math.max(0, right.count - left.count);
    removed += Math.max(0, left.count - right.count);
    retained += retainedForKey;
    evidenceGained += Math.max(0, rightRetainedEvidence - leftRetainedEvidence);
    evidenceLost += Math.max(0, leftRetainedEvidence - rightRetainedEvidence);
    if (left.count !== right.count || left.evidenceBacked !== right.evidenceBacked) {
      changed.push({
        key,
        beforeCount: left.count,
        afterCount: right.count,
        beforeEvidenceBacked: left.evidenceBacked,
        afterEvidenceBacked: right.evidenceBacked,
      });
    }
  }

  return { added, removed, retained, evidenceGained, evidenceLost, changed };
}

function criterionGroups(criteria: readonly GrantCriterion[]): Map<string, { count: number; evidenceBacked: number }> {
  const groups = new Map<string, { count: number; evidenceBacked: number }>();
  for (const criterion of criteria) {
    const key = grantAnalysisCriterionKey(criterion);
    const group = groups.get(key) ?? { count: 0, evidenceBacked: 0 };
    group.count += 1;
    if (grantAnalysisCriterionHasEvidence(criterion)) group.evidenceBacked += 1;
    groups.set(key, group);
  }
  return groups;
}

function transitionSummary(
  before: GrantAnalysisPilotVariant,
  after: GrantAnalysisPilotVariant,
): GrantAnalysisTransitionSummary {
  const result: GrantAnalysisTransitionSummary = {
    axisStateChanges: 0,
    newlyInspected: 0,
    newlyResolved: 0,
    regressions: 0,
    criteriaAdded: 0,
    criteriaRemoved: 0,
    evidenceGained: 0,
    evidenceLost: 0,
  };
  for (const dimension of CRITERION_DIMENSIONS) {
    const left = axisFor(before, dimension);
    const right = axisFor(after, dimension);
    if (left.state !== right.state) result.axisStateChanges += 1;
    if (!isInspectedState(left.state) && isInspectedState(right.state)) result.newlyInspected += 1;
    if (!isResolvedState(left.state) && isResolvedState(right.state)) result.newlyResolved += 1;
    if (
      (isResolvedState(left.state) && !isResolvedState(right.state)) ||
      (isInspectedState(left.state) && (right.state === "failed" || right.state === "not_inspected"))
    ) {
      result.regressions += 1;
    }
    const delta = compareCriteria(left.criteria, right.criteria);
    result.criteriaAdded += delta.added;
    result.criteriaRemoved += delta.removed;
    result.evidenceGained += delta.evidenceGained;
    result.evidenceLost += delta.evidenceLost;
  }
  return result;
}

function variantValues<T>(A: T, B: T, C: T): GrantAnalysisVariantValues<T> {
  return { A, B, C };
}

function assertNonEmpty(value: string, location: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
