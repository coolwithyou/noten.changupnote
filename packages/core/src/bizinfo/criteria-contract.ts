import type { GrantCriterion } from "@cunote/contracts";
import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
} from "@cunote/contracts";
import {
  ALL_DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_EXCEPTIONS,
} from "../disqualification/canonical.js";

const DISQUALIFICATION_AXES = new Set(["tax_compliance", "credit_status", "sanction"]);
const FLAG_SET = new Set<string>(ALL_DISQUALIFICATION_FLAGS);
const EXCEPTION_SET = new Set<string>(DISQUALIFICATION_EXCEPTIONS);

/** 구조화 금지·예약 축(M4). evaluator·프로필 파이프라인이 열리기 전까지 허용하지 않는다. */
const RESERVED_DIMENSIONS = new Set(["premises", "export_performance"]);
/**
 * M1 span 정책 대상 축 — 신규 결격/재무/고용/투자. 구조화(text_only 아님) 시 source_span 필수.
 * 분해기(extract.ts)는 이미 준수한다.
 */
const SPAN_REQUIRED_DIMENSIONS = new Set([
  "prior_award",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
]);

export interface GrantCriteriaContractIssue {
  index: number;
  path: string;
  message: string;
}

const ALLOWED_KEYS = new Set([
  "id",
  "grant_id",
  "dimension",
  "operator",
  "value",
  "kind",
  "weight",
  "confidence",
  "source_span",
  "raw_text",
  "source_field",
  "needs_review",
  "parser_version",
]);

export function validateGrantCriteriaContract(criteria: unknown): GrantCriteriaContractIssue[] {
  if (!Array.isArray(criteria)) {
    return [{
      index: -1,
      path: "$",
      message: "grant criteria must be an array.",
    }];
  }
  const issues = criteria.flatMap((criterion, index) => validateGrantCriterionContract(criterion, index));
  issues.push(...detectDuplicateDimensionSpans(criteria));
  return issues;
}

/**
 * (dimension, kind, operator, source_span) 중복 검출 — 분해기·LLM 이중 카운트 방지(P4).
 * 같은 문장이 required 범위와 exclusion 예외를 동시에 담거나 상·하한을 함께 담을 수
 * 있으므로 dimension/span만 같은 서로 다른 의미의 criterion은 허용한다. 동일한 의미
 * 슬롯까지 겹칠 때만 중복으로 본다. span 없는 criterion(text_only placeholder 등)은
 * 대상에서 제외한다.
 */
function detectDuplicateDimensionSpans(criteria: unknown[]): GrantCriteriaContractIssue[] {
  const issues: GrantCriteriaContractIssue[] = [];
  const seen = new Map<string, number>();
  criteria.forEach((criterion, index) => {
    if (!criterion || typeof criterion !== "object") return;
    const record = criterion as Record<string, unknown>;
    const dimension = typeof record.dimension === "string" ? record.dimension : null;
    const kind = typeof record.kind === "string" ? record.kind : null;
    const operator = typeof record.operator === "string" ? record.operator : null;
    const span = typeof record.source_span === "string" ? record.source_span.trim() : "";
    if (!dimension || !kind || !operator || !span) return;
    const key = `${dimension}\u0000${kind}\u0000${operator}\u0000${span}`;
    const priorIndex = seen.get(key);
    if (priorIndex !== undefined) {
      issues.push({
        index,
        path: `$[${index}].source_span`,
        message: `duplicate (dimension=${dimension}, kind=${kind}, operator=${operator}, span) also at $[${priorIndex}].`,
      });
      return;
    }
    seen.set(key, index);
  });
  return issues;
}

export function assertGrantCriteriaContract(criteria: GrantCriterion[], label = "grant_criteria") {
  const issues = validateGrantCriteriaContract(criteria);
  if (issues.length === 0) return;
  const detail = issues
    .slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} contract validation failed (${issues.length} issue(s)): ${detail}`);
}

function validateGrantCriterionContract(
  criterion: unknown,
  index: number,
): GrantCriteriaContractIssue[] {
  const issues: GrantCriteriaContractIssue[] = [];
  const basePath = `$[${index}]`;
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
    issues.push({
      index,
      path: basePath,
      message: "criterion must be an object.",
    });
    return issues;
  }

  const record = criterion as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      issues.push({
        index,
        path: `${basePath}.${key}`,
        message: "additional property is not allowed.",
      });
    }
  }

  requireEnum(record.dimension, CRITERION_DIMENSIONS, `${basePath}.dimension`, index, issues);
  requireEnum(record.operator, CRITERION_OPERATORS, `${basePath}.operator`, index, issues);
  requireEnum(record.kind, CRITERION_KINDS, `${basePath}.kind`, index, issues);
  if (!record.value || typeof record.value !== "object" || Array.isArray(record.value)) {
    issues.push({
      index,
      path: `${basePath}.value`,
      message: "value must be an object.",
    });
  } else {
    validateDimensionValueSchema(
      record.dimension,
      record.operator,
      record.kind,
      record.value as Record<string, unknown>,
      basePath,
      index,
      issues,
    );
  }
  if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
    issues.push({
      index,
      path: `${basePath}.confidence`,
      message: "confidence must be a number between 0 and 1.",
    });
  }

  detectStructuringViolations(record, basePath, index, issues);

  optionalString(record.id, `${basePath}.id`, index, issues);
  optionalString(record.grant_id, `${basePath}.grant_id`, index, issues);
  optionalNumber(record.weight, `${basePath}.weight`, index, issues);
  optionalString(record.source_span, `${basePath}.source_span`, index, issues);
  optionalString(record.raw_text, `${basePath}.raw_text`, index, issues);
  optionalString(record.source_field, `${basePath}.source_field`, index, issues);
  optionalBoolean(record.needs_review, `${basePath}.needs_review`, index, issues);
  optionalString(record.parser_version, `${basePath}.parser_version`, index, issues);

  return issues;
}

/**
 * 신설 결격/재무/고용/투자 축의 value 스키마 검증(P4).
 * text_only operator 는 note 만 있는 placeholder 이므로 스킵한다(잔존 안전망).
 */
function validateDimensionValueSchema(
  dimension: unknown,
  operator: unknown,
  kind: unknown,
  value: Record<string, unknown>,
  basePath: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  if (typeof dimension !== "string") return;
  if (operator === "text_only") return;
  const path = `${basePath}.value`;

  if (dimension === "region") {
    requireStringArrayField(value.regions, `${path}.regions`, index, issues);
    if ((!Array.isArray(value.regions) || value.regions.length === 0) && value.nationwide !== true) {
      issues.push({ index, path, message: "region requires non-empty regions or nationwide=true." });
    }
    optionalBooleanField(value.nationwide, `${path}.nationwide`, index, issues);
    return;
  }

  if (dimension === "biz_age") {
    optionalNullableNumberField(value.min_months, `${path}.min_months`, index, issues);
    optionalNullableNumberField(value.max_months, `${path}.max_months`, index, issues);
    optionalBooleanField(value.include_preliminary, `${path}.include_preliminary`, index, issues);
    if (
      typeof value.min_months !== "number" &&
      typeof value.max_months !== "number" &&
      value.include_preliminary !== true
    ) {
      issues.push({ index, path, message: "biz_age requires a month bound or include_preliminary=true." });
    }
    return;
  }

  if (dimension === "founder_age") {
    if (!Array.isArray(value.ranges) || value.ranges.length === 0) {
      issues.push({ index, path: `${path}.ranges`, message: "must be a non-empty array." });
      return;
    }
    value.ranges.forEach((range, rangeIndex) => {
      if (!range || typeof range !== "object" || Array.isArray(range)) {
        issues.push({ index, path: `${path}.ranges.${rangeIndex}`, message: "must be an object." });
        return;
      }
      const row = range as Record<string, unknown>;
      optionalNullableNumberField(row.min, `${path}.ranges.${rangeIndex}.min`, index, issues);
      optionalNullableNumberField(row.max, `${path}.ranges.${rangeIndex}.max`, index, issues);
      if (typeof row.min !== "number" && typeof row.max !== "number") {
        issues.push({ index, path: `${path}.ranges.${rangeIndex}`, message: "requires min or max." });
      }
    });
    return;
  }

  const listKey = canonicalListKey(dimension);
  if (listKey) {
    const hasIndustryCodes = dimension === "industry" && Array.isArray(value.codes) && value.codes.length > 0;
    const existenceOnly = operator === "exists";
    if ((!hasIndustryCodes && !existenceOnly) || value[listKey] !== undefined) {
      requireStringArrayField(value[listKey], `${path}.${listKey}`, index, issues);
    }
    if (!existenceOnly && (!Array.isArray(value[listKey]) || value[listKey].length === 0)) {
      if (!hasIndustryCodes) {
        issues.push({ index, path: `${path}.${listKey}`, message: "must be non-empty." });
      }
    }
    if (dimension === "industry" && value.codes !== undefined) {
      requireStringArrayField(value.codes, `${path}.codes`, index, issues);
    }
    if (
      dimension === "target_type"
      && value.list_semantics !== undefined
      && value.list_semantics !== "open"
      && value.list_semantics !== "closed"
    ) {
      issues.push({
        index,
        path: `${path}.list_semantics`,
        message: "must be open|closed.",
      });
    }
    return;
  }

  if (dimension === "revenue" || dimension === "employees") {
    const minKey = dimension === "revenue" ? "min_krw" : "min";
    const maxKey = dimension === "revenue" ? "max_krw" : "max";
    optionalNumberField(value[minKey], `${path}.${minKey}`, index, issues);
    optionalNumberField(value[maxKey], `${path}.${maxKey}`, index, issues);
    if (operator === "gte" && typeof value[minKey] !== "number") {
      issues.push({ index, path: `${path}.${minKey}`, message: `operator gte requires ${minKey}.` });
    }
    if (operator === "lte" && typeof value[maxKey] !== "number") {
      issues.push({ index, path: `${path}.${maxKey}`, message: `operator lte requires ${maxKey}.` });
    }
    if (operator === "between" && typeof value[minKey] !== "number" && typeof value[maxKey] !== "number") {
      issues.push({ index, path, message: `operator between requires ${minKey} or ${maxKey}.` });
    }
    return;
  }

  if (DISQUALIFICATION_AXES.has(dimension)) {
    if (!Array.isArray(value.flags)) {
      issues.push({ index, path: `${path}.flags`, message: "must be a string array." });
    } else {
      for (const flag of value.flags) {
        if (typeof flag !== "string" || !FLAG_SET.has(flag)) {
          issues.push({ index, path: `${path}.flags`, message: `unknown disqualification flag: ${String(flag)}.` });
        }
      }
    }
    if (value.exceptions !== undefined) {
      if (!Array.isArray(value.exceptions)) {
        issues.push({ index, path: `${path}.exceptions`, message: "must be a string array." });
      } else {
        for (const exception of value.exceptions) {
          if (typeof exception !== "string" || !EXCEPTION_SET.has(exception)) {
            issues.push({ index, path: `${path}.exceptions`, message: `unknown exception: ${String(exception)}.` });
          }
        }
      }
    }
    return;
  }

  if (dimension === "prior_award") {
    validatePriorAwardValue(value, kind, path, index, issues);
    return;
  }

  if (dimension === "financial_health") {
    const threshold = value.debt_ratio_pct_threshold;
    if (threshold !== undefined && threshold !== null) {
      if (typeof threshold !== "object" || Array.isArray(threshold)) {
        issues.push({ index, path: `${path}.debt_ratio_pct_threshold`, message: "must be {value, inclusive}." });
      } else {
        const t = threshold as Record<string, unknown>;
        if (typeof t.value !== "number") {
          issues.push({ index, path: `${path}.debt_ratio_pct_threshold.value`, message: "must be a number." });
        }
        if (typeof t.inclusive !== "boolean") {
          issues.push({ index, path: `${path}.debt_ratio_pct_threshold.inclusive`, message: "must be a boolean." });
        }
      }
    }
    if (value.impairment_excluded !== undefined) {
      if (!Array.isArray(value.impairment_excluded)) {
        issues.push({ index, path: `${path}.impairment_excluded`, message: "must be an array." });
      } else {
        for (const item of value.impairment_excluded) {
          if (item !== "partial" && item !== "full") {
            issues.push({ index, path: `${path}.impairment_excluded`, message: `must be partial|full, got ${String(item)}.` });
          }
        }
      }
    }
    optionalNumberField(value.min_interest_coverage, `${path}.min_interest_coverage`, index, issues);
    return;
  }

  if (dimension === "insured_workforce") {
    optionalBooleanField(value.employment_insurance_required, `${path}.employment_insurance_required`, index, issues);
    optionalNumberField(value.min_insured, `${path}.min_insured`, index, issues);
    optionalNumberField(value.max_insured, `${path}.max_insured`, index, issues);
    optionalNumberField(value.no_layoff_within_months, `${path}.no_layoff_within_months`, index, issues);
    return;
  }

  if (dimension === "investment") {
    optionalNumberField(value.min_total_krw, `${path}.min_total_krw`, index, issues);
    if (value.rounds !== undefined && !Array.isArray(value.rounds)) {
      issues.push({ index, path: `${path}.rounds`, message: "must be a string array." });
    }
    optionalBooleanField(value.tips_operator_required, `${path}.tips_operator_required`, index, issues);
    return;
  }
}

function canonicalListKey(dimension: string): string | null {
  if (dimension === "industry") return "tags";
  if (dimension === "size") return "sizes";
  if (dimension === "founder_trait") return "traits";
  if (dimension === "certification") return "certs";
  if (dimension === "ip") return "types";
  if (dimension === "target_type") return "targets";
  return null;
}

function requireStringArrayField(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    issues.push({ index, path, message: "must be a string array." });
  }
}

function optionalNullableNumberField(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    issues.push({ index, path, message: "must be a finite number or null." });
  }
}

const PRIOR_AWARD_SCOPES = new Set(["self", "program", "program_type"]);
const PRIOR_AWARD_SELF_KINDS = new Set([
  "current_similar",
  "same_project",
  "same_business_prior",
  "same_year_other_support",
]);
const PRIOR_AWARD_STATES = new Set(["participating", "completed", "graduated"]);

function validatePriorAwardValue(
  value: Record<string, unknown>,
  kind: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  const scope = value.scope;
  if (scope === undefined) {
    // v1 required/preferred rows used programs/awards/labels/note without a discriminator.
    // They remain readable, but a newly emitted exclusion must use the safe v2 shape.
    if (kind === "exclusion") {
      issues.push({ index, path: `${path}.scope`, message: "is required for prior_award exclusion." });
      return;
    }
    for (const key of ["programs", "awards", "labels"] as const) {
      if (value[key] !== undefined) validateStringArray(value[key], `${path}.${key}`, index, issues, false);
    }
    if (value.note !== undefined && typeof value.note !== "string") {
      issues.push({ index, path: `${path}.note`, message: "must be a string." });
    }
    return;
  }

  if (typeof scope !== "string" || !PRIOR_AWARD_SCOPES.has(scope)) {
    issues.push({ index, path: `${path}.scope`, message: "must be self|program|program_type." });
    return;
  }
  if (value.labels !== undefined) validateStringArray(value.labels, `${path}.labels`, index, issues, false);
  if (value.states !== undefined) {
    validateStringArray(value.states, `${path}.states`, index, issues, false, PRIOR_AWARD_STATES);
  }
  if (value.within !== undefined && value.within !== null) {
    if (typeof value.within !== "object" || Array.isArray(value.within)) {
      issues.push({ index, path: `${path}.within`, message: "must be {value, unit} or null." });
    } else {
      const within = value.within as Record<string, unknown>;
      if (typeof within.value !== "number" || !Number.isFinite(within.value) || within.value <= 0) {
        issues.push({ index, path: `${path}.within.value`, message: "must be a positive number." });
      }
      if (within.unit !== "year" && within.unit !== "month") {
        issues.push({ index, path: `${path}.within.unit`, message: "must be year|month." });
      }
    }
  }

  if (scope === "self") {
    const hasValidSelfKind = typeof value.self_kind === "string" && PRIOR_AWARD_SELF_KINDS.has(value.self_kind);
    const isIncubation = value.channel === "incubation_tenancy";
    if (!hasValidSelfKind && !isIncubation) {
      issues.push({
        index,
        path: `${path}.self_kind`,
        message: "self scope requires a valid self_kind or channel=incubation_tenancy.",
      });
    }
    if (value.self_kind !== undefined && !hasValidSelfKind) {
      issues.push({ index, path: `${path}.self_kind`, message: "contains an unknown prior_award self kind." });
    }
    if (value.channel !== undefined && value.channel !== "general" && value.channel !== "incubation_tenancy") {
      issues.push({ index, path: `${path}.channel`, message: "must be general|incubation_tenancy." });
    }
    return;
  }

  validateStringArray(value.programs, `${path}.programs`, index, issues, true);
}

function validateStringArray(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
  nonEmpty: boolean,
  allowed?: Set<string>,
): void {
  if (!Array.isArray(value)) {
    issues.push({ index, path, message: "must be a string array." });
    return;
  }
  if (nonEmpty && value.length === 0) {
    issues.push({ index, path, message: "must contain at least one item." });
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || (allowed && !allowed.has(item))) {
      issues.push({ index, path, message: `contains an invalid value: ${String(item)}.` });
    }
  }
}

/**
 * 구조화 금지·예약 축·span 정책 위반 검출(M4/M1) — 정규화기 강등의 계약 수준 backstop.
 *   - M4: premises / export_performance 예약 축은 구조화 금지(파이프라인 미활성).
 *   - M1: prior_award 및 신규 결격/재무/고용/투자 축의 구조화 criterion 은 source_span 필수.
 */
function detectStructuringViolations(
  record: Record<string, unknown>,
  basePath: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  const dimension = typeof record.dimension === "string" ? record.dimension : null;
  const operator = typeof record.operator === "string" ? record.operator : null;
  if (!dimension) return;

  // M4: 예약 축은 어떤 형태로도 허용하지 않는다.
  if (RESERVED_DIMENSIONS.has(dimension)) {
    issues.push({
      index,
      path: `${basePath}.dimension`,
      message: `reserved dimension is not allowed: ${dimension} (must be downgraded to other/text_only).`,
    });
    return;
  }

  // M1: 신규 구조화 축은 text_only 가 아니면 source_span 필수.
  if (SPAN_REQUIRED_DIMENSIONS.has(dimension) && operator !== "text_only") {
    const span = typeof record.source_span === "string" ? record.source_span.trim() : "";
    if (!span) {
      issues.push({
        index,
        path: `${basePath}.source_span`,
        message: `${dimension} structured criterion requires source_span (M1 span policy).`,
      });
    }
  }
}

function optionalNumberField(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  if (value !== undefined && value !== null && typeof value !== "number") {
    issues.push({ index, path, message: "must be a number." });
  }
}

function optionalBooleanField(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
): void {
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    issues.push({ index, path, message: "must be a boolean." });
  }
}

function requireEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
) {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push({
      index,
      path,
      message: `must be one of ${allowed.join(", ")}.`,
    });
  }
}

function optionalString(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
) {
  if (value !== undefined && typeof value !== "string") {
    issues.push({ index, path, message: "must be a string." });
  }
}

function optionalNumber(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
) {
  if (value !== undefined && typeof value !== "number") {
    issues.push({ index, path, message: "must be a number." });
  }
}

function optionalBoolean(
  value: unknown,
  path: string,
  index: number,
  issues: GrantCriteriaContractIssue[],
) {
  if (value !== undefined && typeof value !== "boolean") {
    issues.push({ index, path, message: "must be a boolean." });
  }
}
