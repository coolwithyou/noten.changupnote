import type { GrantCriterion } from "@cunote/contracts";
import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
} from "@cunote/contracts";

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
  return criteria.flatMap((criterion, index) => validateGrantCriterionContract(criterion, index));
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
  }
  if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
    issues.push({
      index,
      path: `${basePath}.confidence`,
      message: "confidence must be a number between 0 and 1.",
    });
  }

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
