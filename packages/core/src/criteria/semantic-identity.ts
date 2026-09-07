import type {
  CriterionDimension,
  CriterionOperator,
  GrantCriterion,
} from "@cunote/contracts";
import {
  CRITERION_DIMENSIONS,
  CRITERION_OPERATORS,
} from "@cunote/contracts";

const DIMENSIONS = new Set<string>(CRITERION_DIMENSIONS);
const OPERATORS = new Set<string>(CRITERION_OPERATORS);
const DOWNGRADE_REASONS = new Set([
  "reserved_dimension",
  "missing_required_source_span",
  "contract_validation_failed",
  "region_unresolved",
  "exclusive_upper_bound_mismatch",
  "sanction_cause_state_flattening",
]);

export interface CriterionDowngradeProvenance {
  dimension: CriterionDimension;
  operator: CriterionOperator;
  value: unknown;
}

/** legacy 강등도 공식 원천 정정 보호에 필요한 원래 축만은 안전하게 복원한다. */
export function readCriterionDowngradeOriginalDimension(
  criterion: Pick<GrantCriterion, "dimension" | "operator" | "value">,
): CriterionDimension | null {
  if (
    criterion.dimension !== "other"
    || criterion.operator !== "text_only"
    || !criterion.value
    || typeof criterion.value !== "object"
    || Array.isArray(criterion.value)
  ) return null;
  const value = criterion.value as Record<string, unknown>;
  if (
    typeof value.downgrade_reason !== "string"
    || !DOWNGRADE_REASONS.has(value.downgrade_reason)
    || typeof value.original_dimension !== "string"
    || !DIMENSIONS.has(value.original_dimension)
  ) return null;
  return value.original_dimension as CriterionDimension;
}

/**
 * normalizer가 만든 알려진 other/text_only 강등 형태만 원래 의미로 해석한다.
 * 임의 original_* 필드는 provenance로 신뢰하지 않는다.
 */
export function readCriterionDowngradeProvenance(
  criterion: Pick<GrantCriterion, "dimension" | "operator" | "value">,
): CriterionDowngradeProvenance | null {
  const dimension = readCriterionDowngradeOriginalDimension(criterion);
  if (!dimension || !criterion.value || typeof criterion.value !== "object") return null;
  const value = criterion.value as Record<string, unknown>;
  if (
    typeof value.original_operator !== "string"
    || !OPERATORS.has(value.original_operator)
  ) {
    return null;
  }
  return {
    dimension,
    operator: value.original_operator as CriterionOperator,
    value: Object.hasOwn(value, "original_value") ? value.original_value : criterion.value,
  };
}

/** 원래 축·종류·연산자·값·근거가 모두 같은 조건만 같은 identity를 갖는다. */
export function criterionSemanticIdentity(
  criterion: Pick<GrantCriterion, "dimension" | "kind" | "operator" | "value"> & {
    source_span?: string | null;
  },
): string {
  const original = readCriterionDowngradeProvenance(criterion);
  return [
    original?.dimension ?? criterion.dimension,
    criterion.kind,
    original?.operator ?? criterion.operator,
    stableSemanticJson(original?.value ?? criterion.value),
    normalizeSemanticText(criterion.source_span),
  ].join("\u0000");
}

function stableSemanticJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(normalizeSemanticText(value));
  if (Array.isArray(value)) return `[${value.map(stableSemanticJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSemanticJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeSemanticText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}
