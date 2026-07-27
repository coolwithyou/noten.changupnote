import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
  hasExactDeepAnalysisAxisCoverage,
  type CriterionDimension,
  type CriterionKind,
  type CriterionOperator,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
  type GrantCriterion,
} from "@cunote/contracts";
import {
  canonicalizeGrantCriterion,
  validateGrantCriteriaContract,
} from "@cunote/core";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { sha256Hex, stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_VALIDATOR_VERSION = "deep-analysis-validator-v1" as const;

export type DeepAnalysisValidationIssueCode =
  | "raw_contract_invalid"
  | "normalization_drop"
  | "axis_coverage_invalid"
  | "axis_criterion_mismatch"
  | "unresolved_axis"
  | "evidence_not_grounded"
  | "canonical_contract_invalid"
  | "semantic_duplicate"
  | "input_not_sealed";

export interface DeepAnalysisValidationIssue {
  code: DeepAnalysisValidationIssueCode;
  path: string;
  message: string;
}

export interface DeepAnalysisValidatedCriterion {
  index: number;
  criterion: DeepAnalysisCriterion;
  canonicalCriterion: GrantCriterion;
  semanticSha256: string;
  evidenceRefs: Array<{
    chunkId: string;
    sourceKind: "structured" | "attachment";
    sourceId: string;
    startChar: number;
    endChar: number;
  }>;
}

export interface DeepAnalysisValidationResult {
  validatorVersion: typeof DEEP_ANALYSIS_VALIDATOR_VERSION;
  valid: boolean;
  responseContractValid: boolean;
  axisCoverageComplete: boolean;
  evidenceGrounded: boolean;
  issues: DeepAnalysisValidationIssue[];
  criteria: DeepAnalysisValidatedCriterion[];
  axisCriterionSemanticHashes: Record<CriterionDimension, string[]>;
}

export function validateDeepAnalysisResult(input: {
  seal: DeepAnalysisInputSeal;
  result: DeepAnalysisModelResult;
}): DeepAnalysisValidationResult {
  const issues: DeepAnalysisValidationIssue[] = [];
  if (!input.seal.sealed) {
    issues.push({
      code: "input_not_sealed",
      path: "$.input",
      message: "Deep analysis input seal has unresolved blockers.",
    });
  }

  const rawCriteria = arrayValue(input.result.rawToolInput.criteria);
  const rawAxes = arrayValue(input.result.rawToolInput.axis_assessments);
  validateRawCriteria(rawCriteria, issues);
  validateRawAxes(rawAxes, issues);
  if (rawCriteria.length !== input.result.criteria.length) {
    issues.push({
      code: "normalization_drop",
      path: "$.criteria",
      message: `raw criteria ${rawCriteria.length} != normalized criteria ${input.result.criteria.length}.`,
    });
  }
  if (rawAxes.length !== input.result.axisAssessments.length) {
    issues.push({
      code: "normalization_drop",
      path: "$.axis_assessments",
      message: `raw axes ${rawAxes.length} != normalized axes ${input.result.axisAssessments.length}.`,
    });
  }

  if (!hasExactDeepAnalysisAxisCoverage(input.result.axisAssessments)) {
    issues.push({
      code: "axis_coverage_invalid",
      path: "$.axis_assessments",
      message: "Normalized axis assessments must contain each of the 22 dimensions exactly once.",
    });
  }

  const allValidatedCriteria = input.result.criteria.map((criterion, index) => (
    validateCriterion(input.seal, criterion, index, issues)
  ));
  const validatedCriteria: DeepAnalysisValidatedCriterion[] = [];
  const semanticHashes = new Set<string>();
  for (const validated of allValidatedCriteria) {
    if (semanticHashes.has(validated.semanticSha256)) continue;
    semanticHashes.add(validated.semanticSha256);
    validatedCriteria.push(validated);
  }

  const criteriaByDimension = new Map<CriterionDimension, DeepAnalysisValidatedCriterion[]>();
  for (const dimension of CRITERION_DIMENSIONS) criteriaByDimension.set(dimension, []);
  for (const criterion of validatedCriteria) {
    criteriaByDimension.get(criterion.criterion.dimension)?.push(criterion);
  }
  const axesByDimension = new Map(
    input.result.axisAssessments.map((axis) => [axis.dimension, axis]),
  );
  for (const dimension of CRITERION_DIMENSIONS) {
    const axis = axesByDimension.get(dimension);
    const criteria = criteriaByDimension.get(dimension) ?? [];
    if (!axis) continue;
    if (axis.status === "condition_found" && criteria.length === 0) {
      issues.push({
        code: "axis_criterion_mismatch",
        path: `$.axis_assessments.${dimension}`,
        message: "condition_found requires at least one criterion.",
      });
    }
    if (axis.status !== "condition_found" && criteria.length > 0) {
      issues.push({
        code: "axis_criterion_mismatch",
        path: `$.criteria.${dimension}`,
        message: `Criteria exist while axis status is ${axis.status}.`,
      });
    }
    if (axis.status === "ambiguous" || axis.status === "input_missing") {
      issues.push({
        code: "unresolved_axis",
        path: `$.axis_assessments.${dimension}`,
        message: `Axis status ${axis.status} cannot be analysis_complete.`,
      });
    }
  }

  const responseIssueCodes = new Set<DeepAnalysisValidationIssueCode>([
    "raw_contract_invalid",
    "normalization_drop",
    "canonical_contract_invalid",
    "semantic_duplicate",
  ]);
  const axisIssueCodes = new Set<DeepAnalysisValidationIssueCode>([
    "axis_coverage_invalid",
    "axis_criterion_mismatch",
    "unresolved_axis",
  ]);
  const evidenceIssueCodes = new Set<DeepAnalysisValidationIssueCode>([
    "evidence_not_grounded",
    "input_not_sealed",
  ]);
  const responseContractValid = !issues.some((issue) => responseIssueCodes.has(issue.code));
  const axisCoverageComplete = !issues.some((issue) => axisIssueCodes.has(issue.code));
  const evidenceGrounded = !issues.some((issue) => evidenceIssueCodes.has(issue.code));
  return {
    validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    valid: responseContractValid && axisCoverageComplete && evidenceGrounded,
    responseContractValid,
    axisCoverageComplete,
    evidenceGrounded,
    issues,
    criteria: validatedCriteria,
    axisCriterionSemanticHashes: Object.fromEntries(
      CRITERION_DIMENSIONS.map((dimension) => [
        dimension,
        (criteriaByDimension.get(dimension) ?? []).map((item) => item.semanticSha256).sort(),
      ]),
    ) as Record<CriterionDimension, string[]>,
  };
}

function validateRawCriteria(
  rows: unknown[],
  issues: DeepAnalysisValidationIssue[],
): void {
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      issues.push({
        code: "raw_contract_invalid",
        path: `$.criteria[${index}]`,
        message: "Raw criterion must be an object.",
      });
      return;
    }
    for (const [key, allowed] of [
      ["dimension", CRITERION_DIMENSIONS],
      ["operator", CRITERION_OPERATORS],
      ["kind", CRITERION_KINDS],
    ] as const) {
      if (typeof row[key] !== "string" || !(allowed as readonly string[]).includes(row[key])) {
        issues.push({
          code: "raw_contract_invalid",
          path: `$.criteria[${index}].${key}`,
          message: `Unknown ${key}: ${String(row[key])}.`,
        });
      }
    }
    if (!isRecord(row.value)) {
      issues.push({
        code: "raw_contract_invalid",
        path: `$.criteria[${index}].value`,
        message: "Criterion value must be an object.",
      });
    }
    if (typeof row.source_span !== "string" || !row.source_span.trim()) {
      issues.push({
        code: "raw_contract_invalid",
        path: `$.criteria[${index}].source_span`,
        message: "Criterion source_span must be non-empty.",
      });
    }
  });
}

function validateRawAxes(
  rows: unknown[],
  issues: DeepAnalysisValidationIssue[],
): void {
  if (rows.length !== CRITERION_DIMENSIONS.length) {
    issues.push({
      code: "axis_coverage_invalid",
      path: "$.axis_assessments",
      message: `Raw axis count must be ${CRITERION_DIMENSIONS.length}, got ${rows.length}.`,
    });
  }
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      issues.push({
        code: "raw_contract_invalid",
        path: `$.axis_assessments[${index}]`,
        message: "Raw axis must be an object.",
      });
      return;
    }
    const dimension = row.dimension;
    if (typeof dimension !== "string"
      || !(CRITERION_DIMENSIONS as readonly string[]).includes(dimension)
      || seen.has(dimension)) {
      issues.push({
        code: "axis_coverage_invalid",
        path: `$.axis_assessments[${index}].dimension`,
        message: `Unknown or duplicate axis: ${String(dimension)}.`,
      });
    } else {
      seen.add(dimension);
    }
    if (!["condition_found", "inspected_no_condition", "ambiguous", "input_missing"]
      .includes(String(row.status))) {
      issues.push({
        code: "raw_contract_invalid",
        path: `$.axis_assessments[${index}].status`,
        message: `Unknown axis status: ${String(row.status)}.`,
      });
    }
  });
}

function validateCriterion(
  seal: DeepAnalysisInputSeal,
  criterion: DeepAnalysisCriterion,
  index: number,
  issues: DeepAnalysisValidationIssue[],
): DeepAnalysisValidatedCriterion {
  const grantCriterion: GrantCriterion = {
    dimension: criterion.dimension,
    operator: criterion.operator as CriterionOperator,
    kind: criterion.kind as CriterionKind,
    value: isRecord(criterion.value) ? criterion.value : {},
    confidence: criterion.confidence,
    ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
    needs_review: criterion.dimension === "premises" || criterion.dimension === "export_performance",
    parser_version: DEEP_ANALYSIS_VALIDATOR_VERSION,
  };
  const canonicalCriterion = canonicalizeGrantCriterion(grantCriterion);
  if (criterion.dimension === "premises" || criterion.dimension === "export_performance") {
    const note = isRecord(criterion.value) && typeof criterion.value.note === "string"
      ? criterion.value.note.trim()
      : "";
    if (criterion.operator !== "text_only" || !note) {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}].value`,
        message: `${criterion.dimension} must remain text_only with a non-empty value.note.`,
      });
    }
  } else {
    for (const issue of validateGrantCriteriaContract([canonicalCriterion])) {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}]${issue.path.slice(4)}`,
        message: issue.message,
      });
    }
  }
  if (criterion.dimension === "investment" && criterion.operator !== "text_only") {
    const value = isRecord(criterion.value) ? criterion.value : {};
    if (value.max_total_krw !== undefined) {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}].value.max_total_krw`,
        message: "investment max_total_krw is not supported by the current matcher; use investment/text_only.",
      });
    }
    if (criterion.operator === "lte" || criterion.operator === "between") {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}].operator`,
        message: "investment upper bounds are not canonical; use investment/text_only with value.note.",
      });
    }
    if (criterion.operator === "gte" && typeof value.min_total_krw !== "number") {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}].value.min_total_krw`,
        message: "investment operator=gte requires min_total_krw.",
      });
    }
  }

  const evidenceRefs = locateEvidence(seal, criterion.sourceSpan);
  if (!criterion.spanVerified || evidenceRefs.length === 0) {
    issues.push({
      code: "evidence_not_grounded",
      path: `$.criteria[${index}].source_span`,
      message: "source_span does not exactly map to a sealed structured/attachment chunk.",
    });
  }
  const semanticSha256 = sha256Hex(stableJson({
    dimension: canonicalCriterion.dimension,
    operator: canonicalCriterion.operator,
    kind: canonicalCriterion.kind,
    value: canonicalizeSemanticValue(canonicalCriterion.value),
  }));
  return {
    index,
    criterion,
    canonicalCriterion,
    semanticSha256,
    evidenceRefs,
  };
}

function canonicalizeSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...new Set(value)].sort();
    }
    return value.map(canonicalizeSemanticValue);
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      canonicalizeSemanticValue(item),
    ]),
  );
}

function locateEvidence(
  seal: DeepAnalysisInputSeal,
  sourceSpan: string | null,
): DeepAnalysisValidatedCriterion["evidenceRefs"] {
  if (!sourceSpan) return [];
  return seal.chunks.flatMap((chunk) => {
    const offset = chunk.text.indexOf(sourceSpan);
    if (offset < 0) return [];
    return [{
      chunkId: chunk.id,
      sourceKind: chunk.sourceKind,
      sourceId: chunk.sourceId,
      startChar: chunk.startChar + offset,
      endChar: chunk.startChar + offset + sourceSpan.length,
    }];
  });
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
