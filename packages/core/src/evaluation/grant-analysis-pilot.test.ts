import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS, type CriterionDimension, type GrantCriterion } from "@cunote/contracts";
import {
  compareGrantAnalysisPilotVariants,
  createGrantAnalysisPilotVariant,
  grantAnalysisAxisRole,
  grantAnalysisCriterionKey,
  summarizeGrantAnalysisPilotVariant,
  type GrantAnalysisAxisAssessmentInput,
  type GrantAnalysisInputArtifact,
  type GrantAnalysisPilotVariantId,
  type GrantAnalysisPilotVariantInput,
} from "./grant-analysis-pilot.js";

const regionWithoutEvidence = criterion("region", { regions: ["11"] });
const regionWithEvidence = { ...regionWithoutEvidence, source_span: "서울특별시 소재 기업" };
const industryWithEvidence = criterion("industry", { keywords: ["AI"] }, { source_field: "aply_trgt_ctnt" });
const bizAgeWithEvidence = criterion("biz_age", { max_months: 84 }, { source_span: "창업 7년 이내" });

const customAxes = axes({
  region: { state: "structured", criteria: [regionWithEvidence] },
  biz_age: { state: "explicit_no_condition", criteria: [] },
  industry: {
    state: "text_only",
    criteria: [criterion("industry", { text: "AI 관련 기업" }, {
      operator: "text_only",
      source_span: "AI 관련 기업 우대",
    })],
  },
  size: {
    state: "evidence_missing",
    criteria: [criterion("size", { values: ["small"] })],
  },
  revenue: { state: "failed", criteria: [], note: "table parser failed" },
  employees: { state: "not_inspected", criteria: [] },
});
const canonical = createGrantAnalysisPilotVariant(variant("A", customAxes, inputUniverse("A")));

assert.equal(canonical.axes.length, CRITERION_DIMENSIONS.length);
assert.deepEqual(canonical.axes.map((axis) => axis.dimension), [...CRITERION_DIMENSIONS]);
assert.equal(grantAnalysisAxisRole("premises"), "reserved");
assert.equal(grantAnalysisAxisRole("export_performance"), "reserved");
assert.equal(grantAnalysisAxisRole("other"), "catch_all");
assert.equal(canonical.axes.find((axis) => axis.dimension === "other")?.role, "catch_all");

const summary = summarizeGrantAnalysisPilotVariant(canonical);
assert.deepEqual(summary.input, {
  expected: 3,
  fetched: 3,
  converted: 2,
  included: 1,
  failed: 1,
  fetchCoverage: 1,
  conversionCoverage: 0.6667,
  inclusionCoverage: 0.3333,
  byKind: {
    api_text: {
      expected: 1, fetched: 1, converted: 1, included: 1, failed: 0,
      fetchCoverage: 1, conversionCoverage: 1, inclusionCoverage: 1,
    },
    attachment: {
      expected: 2, fetched: 2, converted: 1, included: 0, failed: 1,
      fetchCoverage: 1, conversionCoverage: 0.5, inclusionCoverage: 0,
    },
  },
});
assert.equal(summary.axes.total, 22);
assert.equal(summary.axes.inspectable, 20);
assert.equal(summary.axes.reserved, 2);
assert.equal(summary.axes.attempted, 19);
assert.equal(summary.axes.inspected, 18);
assert.equal(summary.axes.resolved, 16);
assert.equal(summary.axes.failed, 1);
assert.equal(summary.axes.notInspected, 1);
assert.equal(summary.axes.inspectionCoverage, 0.9);
assert.equal(summary.axes.resolutionCoverage, 0.8);
assert.deepEqual(summary.evidence, {
  criteria: 3,
  evidenceBacked: 2,
  missing: 1,
  coverage: 0.6667,
});

assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", customAxes.slice(1), inputUniverse("A"))),
  /every criterion dimension exactly once; missing: region/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", [...customAxes, customAxes[0] as GrantAnalysisAxisAssessmentInput], inputUniverse("A"))),
  /duplicate axis assessment: region/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", axes({ premises: { state: "not_inspected", criteria: [] } }), inputUniverse("A"))),
  /premises: reserved dimension must use reserved state/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", axes({ other: { state: "reserved", criteria: [] } }), inputUniverse("A"))),
  /other: only premises and export_performance may be reserved/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", axes({ region: { state: "structured", criteria: [regionWithoutEvidence] } }), inputUniverse("A"))),
  /structured criteria must be evidence-backed/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", axes({ region: { state: "structured", criteria: [] } }), inputUniverse("A"))),
  /assessment state requires at least one criterion/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", axes({ region: { state: "structured", criteria: [bizAgeWithEvidence] } }), inputUniverse("A"))),
  /criterion dimension must match its axis/,
);
assert.throws(
  () => createGrantAnalysisPilotVariant(variant("A", customAxes, [{
    inputId: "bad", kind: "attachment", fetched: true, converted: false, included: true,
  } ])),
  /included input must be converted/,
);

assert.equal(
  grantAnalysisCriterionKey({ ...regionWithEvidence, confidence: 0.2, parser_version: "new" }),
  grantAnalysisCriterionKey({ ...regionWithEvidence, confidence: 0.99, source_span: "다른 근거" }),
  "semantic criterion identity must ignore confidence, parser metadata, and evidence",
);

const A = variant("A", axes({
  region: { state: "evidence_missing", criteria: [regionWithoutEvidence] },
  industry: { state: "not_inspected", criteria: [] },
  biz_age: { state: "explicit_no_condition", criteria: [] },
}), inputUniverse("A"));
const B = variant("B", axes({
  region: { state: "structured", criteria: [regionWithEvidence] },
  industry: { state: "structured", criteria: [industryWithEvidence] },
  biz_age: { state: "explicit_no_condition", criteria: [] },
}), inputUniverse("B"));
const C = variant("C", axes({
  region: { state: "structured", criteria: [regionWithEvidence] },
  industry: { state: "structured", criteria: [industryWithEvidence] },
  biz_age: { state: "structured", criteria: [bizAgeWithEvidence] },
}), inputUniverse("C"));
const comparison = compareGrantAnalysisPilotVariants([C, A, B]);

assert.equal(comparison.grantId, "kstartup:pilot-1");
assert.equal(comparison.sourceRevision, "sha256:fixed");
const regionComparison = comparison.axes.find((axis) => axis.dimension === "region");
assert.deepEqual(regionComparison?.states, { A: "evidence_missing", B: "structured", C: "structured" });
assert.equal(regionComparison?.deltas.AtoB.added, 0);
assert.equal(regionComparison?.deltas.AtoB.removed, 0);
assert.equal(regionComparison?.deltas.AtoB.retained, 1);
assert.equal(regionComparison?.deltas.AtoB.evidenceGained, 1);
const industryComparison = comparison.axes.find((axis) => axis.dimension === "industry");
assert.equal(industryComparison?.deltas.AtoB.added, 1);
const bizAgeComparison = comparison.axes.find((axis) => axis.dimension === "biz_age");
assert.equal(bizAgeComparison?.deltas.BtoC.added, 1);
assert.deepEqual(comparison.transitions.AtoB, {
  axisStateChanges: 2,
  newlyInspected: 1,
  newlyResolved: 2,
  regressions: 0,
  criteriaAdded: 1,
  criteriaRemoved: 0,
  evidenceGained: 1,
  evidenceLost: 0,
});
assert.deepEqual(comparison.transitions.BtoC, {
  axisStateChanges: 1,
  newlyInspected: 0,
  newlyResolved: 0,
  regressions: 0,
  criteriaAdded: 1,
  criteriaRemoved: 0,
  evidenceGained: 0,
  evidenceLost: 0,
});
assert.equal(comparison.summaries.A.input.inclusionCoverage, 0.3333);
assert.equal(comparison.summaries.B.input.inclusionCoverage, 0.3333);
assert.equal(comparison.summaries.C.input.inclusionCoverage, 1);

assert.throws(() => compareGrantAnalysisPilotVariants([A, B]), /requires A, B, and C exactly once/);
assert.throws(() => compareGrantAnalysisPilotVariants([A, B, { ...C, sourceRevision: "sha256:different" }]), /same sourceRevision/);
assert.throws(() => compareGrantAnalysisPilotVariants([A, B, {
  ...C,
  inputs: C.inputs.slice(0, 2),
}]), /same expected input universe/);

console.log("grant-analysis-pilot.test.ts: all assertions passed");

function variant(
  id: GrantAnalysisPilotVariantId,
  axisAssessments: readonly GrantAnalysisAxisAssessmentInput[],
  inputs: readonly GrantAnalysisInputArtifact[],
): GrantAnalysisPilotVariantInput {
  return {
    variant: id,
    grantId: "kstartup:pilot-1",
    sourceRevision: "sha256:fixed",
    extractorVersion: id === "A" ? "production-v1" : "pilot-v1",
    inputs,
    axes: axisAssessments,
  };
}

function axes(
  overrides: Partial<Record<CriterionDimension, Omit<GrantAnalysisAxisAssessmentInput, "dimension">>> = {},
): GrantAnalysisAxisAssessmentInput[] {
  return CRITERION_DIMENSIONS.map((dimension) => {
    const override = overrides[dimension];
    if (override) return { dimension, ...override };
    if (dimension === "premises" || dimension === "export_performance") {
      return { dimension, state: "reserved", criteria: [] };
    }
    return { dimension, state: "explicit_no_condition", criteria: [] };
  });
}

function criterion(
  dimension: CriterionDimension,
  value: Record<string, unknown>,
  overrides: Partial<GrantCriterion> = {},
): GrantCriterion {
  return {
    dimension,
    operator: "in",
    kind: "required",
    confidence: 0.9,
    value,
    ...overrides,
  };
}

function inputUniverse(variantId: GrantAnalysisPilotVariantId): GrantAnalysisInputArtifact[] {
  return [
    {
      inputId: "api:detail",
      kind: "api_text",
      fetched: true,
      converted: true,
      included: true,
    },
    {
      inputId: "attachment:notice.pdf",
      kind: "attachment",
      fetched: true,
      converted: true,
      included: variantId === "C",
    },
    {
      inputId: "attachment:form.hwp",
      kind: "attachment",
      fetched: true,
      converted: variantId === "C",
      included: variantId === "C",
      ...(variantId === "A" ? { failure: "conversion failed" } : {}),
    },
  ];
}
