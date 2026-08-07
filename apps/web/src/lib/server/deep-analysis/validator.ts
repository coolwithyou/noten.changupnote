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
  EXCEPTION_FLAG_COVERAGE,
  canonicalizeGrantCriterion,
  nonMatchingCriterionReason,
  validateGrantCriteriaContract,
  type DisqualificationException,
  type DisqualificationFlag,
} from "@cunote/core";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { sha256Hex, stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_VALIDATOR_VERSION = "deep-analysis-validator-v7" as const;

export type DeepAnalysisValidationIssueCode =
  | "raw_contract_invalid"
  | "normalization_drop"
  | "axis_coverage_invalid"
  | "axis_criterion_mismatch"
  | "unresolved_axis"
  | "evidence_not_grounded"
  | "canonical_contract_invalid"
  | "semantic_duplicate"
  | "logical_conflict"
  | "non_matching_criterion"
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
  validateRequiredExclusionConflicts(validatedCriteria, issues);
  validateStartupStageTargetDuplicates(validatedCriteria, issues);
  validateApplicationMatchingScope(validatedCriteria, issues);

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
    "logical_conflict",
    "non_matching_criterion",
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

function validateApplicationMatchingScope(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    const reason = nonMatchingCriterionReason(item.canonicalCriterion);
    if (!reason) continue;
    issues.push({
      code: "non_matching_criterion",
      path: `$.criteria[${item.index}]`,
      message:
        `${reason}: application procedure or post-selection obligation cannot be used for company matching; preserve it only in analysis/caution text.`,
    });
  }
}

const STARTUP_STAGE_TARGETS = new Set([
  "예비창업자",
  "예비창업기업",
  "초기창업자",
  "초기창업기업",
]);

/**
 * 특정 창업지원 프로그램 선정 이력을 설명하는 같은 문구에서 예비·초기창업자
 * 꼬리표를 target_type으로 다시 발행하면 사업자번호 프로필에 불필요한 unknown이
 * 생긴다. 이 한 조합만 막고, 독립적으로 명시된 창업단계·학생·법적 유형 조건은 둔다.
 */
function validateStartupStageTargetDuplicates(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const priorAwardCriteria = criteria.filter((item) => {
    if (
      item.criterion.dimension !== "prior_award"
      || item.criterion.kind !== "required"
      || item.criterion.operator !== "in"
    ) return false;
    const value = isRecord(item.canonicalCriterion.value)
      ? item.canonicalCriterion.value
      : {};
    const programs = stringArray(value.programs);
    const states = stringArray(value.states);
    return programs.length > 0
      && states.some((state) => state === "completed" || state === "participating");
  });
  if (priorAwardCriteria.length === 0) return;

  for (const targetType of criteria) {
    if (
      targetType.criterion.dimension !== "target_type"
      || targetType.criterion.kind !== "required"
      || targetType.criterion.operator !== "in"
    ) continue;
    const value = isRecord(targetType.canonicalCriterion.value)
      ? targetType.canonicalCriterion.value
      : {};
    const targets = stringArray(value.targets).map(normalizeStartupStageTarget);
    if (
      targets.length === 0
      || targets.some((target) => !STARTUP_STAGE_TARGETS.has(target))
    ) continue;

    const duplicate = priorAwardCriteria.find((priorAward) => (
      evidenceRangesMateriallyOverlap(targetType, priorAward)
      || evidenceTextsMateriallyOverlap(
        targetType.criterion.sourceSpan,
        priorAward.criterion.sourceSpan,
      )
    ));
    if (!duplicate) continue;
    issues.push({
      code: "semantic_duplicate",
      path: `$.criteria[${targetType.index}]`,
      message:
        `Startup-stage target_type duplicates prior_award criterion at $.criteria[${duplicate.index}] from the same eligibility phrase. Keep prior_award and remove this target_type.`,
    });
  }
}

function evidenceRangesMateriallyOverlap(
  left: DeepAnalysisValidatedCriterion,
  right: DeepAnalysisValidatedCriterion,
): boolean {
  return left.evidenceRefs.some((leftRef) => right.evidenceRefs.some((rightRef) => {
    if (leftRef.chunkId !== rightRef.chunkId) return false;
    const overlap = Math.max(
      0,
      Math.min(leftRef.endChar, rightRef.endChar)
      - Math.max(leftRef.startChar, rightRef.startChar),
    );
    const shorter = Math.min(
      leftRef.endChar - leftRef.startChar,
      rightRef.endChar - rightRef.startChar,
    );
    return shorter > 0 && overlap / shorter >= 0.6;
  }));
}

function evidenceTextsMateriallyOverlap(
  left: string | null,
  right: string | null,
): boolean {
  const leftText = normalizeComparableEvidence(left);
  const rightText = normalizeComparableEvidence(right);
  if (leftText.length < 12 || rightText.length < 12) return false;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = shorter === leftText ? rightText : leftText;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.65;
}

function normalizeComparableEvidence(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/^(?:신청자격|지원자격|지원대상|신청대상|대상기업)+/u, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLowerCase();
}

function normalizeStartupStageTarget(value: string): string {
  return value.normalize("NFKC").replace(/[\s·ㆍ_-]/g, "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function validateRequiredExclusionConflicts(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const required = new Set(
    criteria
      .filter((item) => item.criterion.kind === "required")
      .map(criterionPolarityKey),
  );
  for (const item of criteria) {
    if (
      item.criterion.kind !== "exclusion"
      || !required.has(criterionPolarityKey(item))
    ) continue;
    issues.push({
      code: "logical_conflict",
      path: `$.criteria[${item.index}]`,
      message:
        `${item.criterion.dimension} has the same value in required and exclusion criteria.`,
    });
  }
}

function criterionPolarityKey(item: DeepAnalysisValidatedCriterion): string {
  return stableJson({
    dimension: item.canonicalCriterion.dimension,
    operator: item.canonicalCriterion.operator === "in"
      || item.canonicalCriterion.operator === "not_in"
      ? "membership"
      : item.canonicalCriterion.operator,
    value: canonicalizeSemanticValue(item.canonicalCriterion.value),
  });
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
  validateExceptionCoverage(criterion, index, issues);
  validateMatcherSemanticCompleteness(criterion, index, issues);
  if (criterion.dimension === "target_type") {
    const rawValue = isRecord(criterion.value) ? criterion.value : {};
    if (
      rawValue.list_semantics !== undefined
      && rawValue.list_semantics !== "open"
      && rawValue.list_semantics !== "closed"
    ) {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}].value.list_semantics`,
        message: "target_type value.list_semantics must be open or closed.",
      });
    }
    const value = isRecord(canonicalCriterion.value) ? canonicalCriterion.value : {};
    const targets = Array.isArray(value.targets)
      ? value.targets.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    if (
      (criterion.operator !== "in" && criterion.operator !== "not_in")
      || targets.length === 0
    ) {
      issues.push({
        code: "canonical_contract_invalid",
        path: `$.criteria[${index}]`,
        message:
          "target_type must be a structured in/not_in legal applicant type with non-empty value.targets; use other/text_only for non-type rules.",
      });
    } else {
      for (const issue of validateGrantCriteriaContract([canonicalCriterion])) {
        issues.push({
          code: "canonical_contract_invalid",
          path: `$.criteria[${index}]${issue.path.slice(4)}`,
          message: issue.message,
        });
      }
    }
  } else if (criterion.dimension === "premises" || criterion.dimension === "export_performance") {
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

function validateMatcherSemanticCompleteness(
  criterion: DeepAnalysisCriterion,
  index: number,
  issues: DeepAnalysisValidationIssue[],
): void {
  if (criterion.operator === "text_only") return;
  const span = (criterion.sourceSpan ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const value = isRecord(criterion.value) ? criterion.value : {};
  const reject = (message: string, path = "") => {
    issues.push({
      code: "canonical_contract_invalid",
      path: `$.criteria[${index}]${path}`,
      message,
    });
  };

  if (
    criterion.dimension === "investment"
    && (/(?:공고|접수)\s*(?:마감일?)?.{0,24}\d+\s*년\s*이내/u.test(span)
      || /[’']?\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}.{0,12}(?:~|∼|부터).{0,12}[’']?\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}/u.test(span))
  ) {
    reject(
      "Investment amount combined with a time window is not losslessly representable; use investment/text_only with the complete predicate.",
      ".operator",
    );
  }

  if (
    criterion.dimension === "region"
    && /(?:협약|선정).{0,24}(?:전|체결).{0,24}(?:이전|주소지)/u.test(span)
    && /(?:이전\s*예정|확약서|이전\s*완료)/u.test(span)
  ) {
    reject(
      "A future relocation alternative cannot be reduced to the company's current region; use region/text_only with the full alternative path.",
      ".operator",
    );
  }

  if (
    criterion.dimension === "industry"
    && /신고.{0,6}등록.{0,16}(?:되지\s*않|아니|미등록)/u.test(span)
  ) {
    reject(
      "A registration-qualified industry exclusion cannot be reduced to unconditional industry tags; use industry/text_only.",
      ".operator",
    );
  }

  if (criterion.dimension === "business_status" && /휴\s*[·‧ㆍ/・-]?\s*폐업/u.test(span)) {
    const statuses = stringArray(value.statuses);
    if (!statuses.includes("suspended") || !statuses.includes("closed")) {
      reject(
        "휴·폐업 exclusion requires both suspended and closed statuses.",
        ".value.statuses",
      );
    }
  }

  if (
    criterion.dimension === "prior_award"
    && /(?:중단\s*처분|중도\s*포기)/u.test(span)
    && stringArray(value.states).length > 0
  ) {
    reject(
      "A program-history exclusion that explicitly includes termination or withdrawal must omit states so every agreement history is covered.",
      ".value.states",
    );
  }

  if (
    criterion.dimension === "sanction"
    && /환수금.{0,40}반환.{0,20}(?:종결되지\s*않|미종결)/u.test(span)
  ) {
    reject(
      "Unresolved refund repayment does not imply subsidy fraud; preserve the complete condition as sanction/text_only.",
      ".operator",
    );
  }
}

function validateExceptionCoverage(
  criterion: DeepAnalysisCriterion,
  index: number,
  issues: DeepAnalysisValidationIssue[],
): void {
  if (
    criterion.dimension !== "tax_compliance"
    && criterion.dimension !== "credit_status"
    && criterion.dimension !== "sanction"
  ) return;
  const value = isRecord(criterion.value) ? criterion.value : {};
  const flags = Array.isArray(value.flags)
    ? value.flags.filter((flag): flag is DisqualificationFlag => typeof flag === "string")
    : [];
  const exceptions = Array.isArray(value.exceptions)
    ? value.exceptions.filter(
      (exception): exception is DisqualificationException =>
        typeof exception === "string" && exception in EXCEPTION_FLAG_COVERAGE,
    )
    : [];
  for (const exception of exceptions) {
    if (EXCEPTION_FLAG_COVERAGE[exception].some((flag) => flags.includes(flag))) continue;
    issues.push({
      code: "canonical_contract_invalid",
      path: `$.criteria[${index}].value.exceptions`,
      message: `Exception ${exception} does not cover any criterion flag.`,
    });
  }
}

function canonicalizeSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...new Set(value)].sort();
    }
    return value.map(canonicalizeSemanticValue);
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  const semanticEntries = entries.some(([key]) => key !== "note")
    ? entries.filter(([key]) => key !== "note")
    : entries;
  return Object.fromEntries(
    semanticEntries.map(([key, item]) => [
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
