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

export const DEEP_ANALYSIS_VALIDATOR_VERSION = "deep-analysis-validator-v12" as const;

export type DeepAnalysisValidationIssueCode =
  | "raw_contract_invalid"
  | "normalization_drop"
  | "axis_coverage_invalid"
  | "axis_criterion_mismatch"
  | "unresolved_axis"
  | "evidence_not_grounded"
  | "canonical_contract_invalid"
  | "semantic_duplicate"
  | "semantic_misattribution"
  | "high_risk_condition_gap"
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

export type DeepAnalysisValidationRoute =
  | { route: "accept"; repairIssues: []; holdIssues: [] }
  | {
      route: "repair";
      repairIssues: DeepAnalysisValidationIssue[];
      holdIssues: DeepAnalysisValidationIssue[];
    }
  | {
      route: "hold";
      repairIssues: [];
      holdIssues: DeepAnalysisValidationIssue[];
    };

/**
 * strict validator 결과를 실행 선택으로 해석한다. unresolved-only는 의미를 꾸며서
 * 통과시키거나 전체 22축을 다시 생성하지 않고 보류한다. hold 축에 criterion이 함께 있어
 * 생긴 axis mismatch도 같은 보류 원인의 일부로 본다. 그 밖의 계약 오류가 하나라도 섞이면
 * 기존 repair를 유지하고, path나 axis 상태가 예상과 다르면 fail-closed repair한다.
 */
export function decideDeepAnalysisValidationRoute(input: {
  result: DeepAnalysisModelResult;
  validation: DeepAnalysisValidationResult;
}): DeepAnalysisValidationRoute {
  if (input.validation.valid) {
    return { route: "accept", repairIssues: [], holdIssues: [] };
  }
  const heldDimensions = new Set<CriterionDimension>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "unresolved_axis") continue;
    const dimension = criterionDimensionFromIssuePath(issue.path, "axis_assessments");
    const axis = dimension
      ? input.result.axisAssessments.find((candidate) => candidate.dimension === dimension)
      : undefined;
    if (axis?.status === "ambiguous" || axis?.status === "input_missing") {
      heldDimensions.add(axis.dimension);
    }
  }
  const holdIssues: DeepAnalysisValidationIssue[] = [];
  const repairIssues: DeepAnalysisValidationIssue[] = [];
  for (const issue of input.validation.issues) {
    const unresolvedDimension = issue.code === "unresolved_axis"
      ? criterionDimensionFromIssuePath(issue.path, "axis_assessments")
      : null;
    if (unresolvedDimension && heldDimensions.has(unresolvedDimension)) {
      holdIssues.push(issue);
      continue;
    }
    const mismatchedCriterionDimension = issue.code === "axis_criterion_mismatch"
      ? criterionDimensionFromIssuePath(issue.path, "criteria")
      : null;
    if (mismatchedCriterionDimension && heldDimensions.has(mismatchedCriterionDimension)) {
      holdIssues.push(issue);
    } else {
      repairIssues.push(issue);
    }
  }
  if (repairIssues.length > 0 || holdIssues.length === 0) {
    return { route: "repair", repairIssues, holdIssues };
  }
  return { route: "hold", repairIssues: [], holdIssues };
}

function criterionDimensionFromIssuePath(
  path: string,
  collection: "axis_assessments" | "criteria",
): CriterionDimension | null {
  const raw = new RegExp(`^\\$\\.${collection}\\.([a-z_]+)$`).exec(path)?.[1];
  return raw && (CRITERION_DIMENSIONS as readonly string[]).includes(raw)
    ? raw as CriterionDimension
    : null;
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
  validateScopedSemanticDuplicates(allValidatedCriteria, issues);
  const validatedCriteria: DeepAnalysisValidatedCriterion[] = [];
  const semanticHashes = new Set<string>();
  for (const validated of allValidatedCriteria) {
    if (semanticHashes.has(validated.semanticSha256)) continue;
    semanticHashes.add(validated.semanticSha256);
    validatedCriteria.push(validated);
  }
  validateRequiredExclusionConflicts(validatedCriteria, issues);
  validateStartupStageTargetDuplicates(validatedCriteria, issues);
  validateLocationTenureBusinessAge(validatedCriteria, issues);
  validateApplicationMatchingScope(validatedCriteria, issues);
  validateActorAndTrackScope(validatedCriteria, issues);
  validateAlternativeApplicantPaths(validatedCriteria, issues);
  validateStructuredFilterMetadata(input.seal, validatedCriteria, issues);
  validateProceduralEvidenceChecks(validatedCriteria, issues);
  validatePriorAwardLosslessScope(validatedCriteria, issues);
  validateEligibilityRankingSeparation(input.seal, validatedCriteria, issues);
  validateHighRiskConditionCoverage(input.seal, validatedCriteria, issues);

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
    "semantic_misattribution",
    "high_risk_condition_gap",
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

const LOCATION_TENURE_CONTEXT_PATTERN =
  /(?:소재|입주(?!\s*신청일)|사업장|본사|공장|주소지|거주|이전)/u;
const DURATION_PATTERN = /\d+(?:\.\d+)?\s*(?:년|개월|월)\s*(?:이상|이하|초과|미만|이내|경과)?/u;
const EXPLICIT_BUSINESS_AGE_PATTERN =
  /(?:업력|사업\s*영위\s*기간|창업\s*일.{0,8}\d|(?:설립|창업|개업)(?:\s*(?:일|한\s*지|된\s*지|후|이후|로부터))?\s*\d|사업\s*개시|사업자\s*등록(?:일)?(?:로부터|후|이후))/u;

/**
 * 소재·입주 기간은 사업체가 존속한 기간의 필요조건처럼 보일 수 있지만, 신청
 * 자격의 의미는 premises에 있다. 별도의 설립·업력 근거 없이 같은 기간을
 * biz_age로도 발행하면 실제 공고보다 강한 업력 조건을 만들어내므로 막는다.
 */
function validateLocationTenureBusinessAge(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    if (item.criterion.dimension !== "biz_age") continue;
    const sourceSpan = (item.criterion.sourceSpan ?? "").normalize("NFKC");
    if (
      !LOCATION_TENURE_CONTEXT_PATTERN.test(sourceSpan)
      || !DURATION_PATTERN.test(sourceSpan)
      || EXPLICIT_BUSINESS_AGE_PATTERN.test(sourceSpan)
    ) continue;
    issues.push({
      code: "semantic_misattribution",
      path: `$.criteria[${item.index}]`,
      message:
        "The duration modifies location, occupancy, or premises rather than company age. Remove this biz_age criterion and set the biz_age axis to inspected_no_condition unless separate founding-age evidence exists; preserve the location-tenure rule as premises/text_only.",
    });
  }
}

function validateApplicationMatchingScope(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    const reason = nonMatchingCriterionReason({
      ...item.canonicalCriterion,
      value: item.criterion.value,
      note: item.criterion.note,
    });
    if (!reason) continue;
    const message = reason === "program_job_field"
      ? "Program job/placement field cannot be used as an applicant-company industry criterion; preserve it only in program intent."
      : reason === "program_collaboration_theme"
        ? "A demand-company collaboration theme or proposed project field is not the applicant company's industry; preserve an eligibility-impacting project scope as other/text_only, otherwise keep it only in program intent."
      : reason === "unresolved_industry_job_field"
        ? "Unresolved industry-vs-job-field wording cannot become a blocking industry criterion; use input_missing when the disambiguating attachment is absent."
        : `${reason}: application procedure or post-selection obligation cannot be used for company matching; preserve it only in analysis/caution text.`;
    issues.push({
      code: "non_matching_criterion",
      path: `$.criteria[${item.index}]`,
      message,
    });
  }
}

function validateStructuredFilterMetadata(
  seal: DeepAnalysisInputSeal,
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    const context = criterionEvidenceContext(seal, item);
    if (
      item.criterion.dimension === "region"
      && /source_field\s*:\s*supt_regin/iu.test(context)
    ) {
      issues.push({
        code: "semantic_misattribution",
        path: `$.criteria[${item.index}]`,
        message:
          "K-Startup supt_regin is portal/service-region metadata, not proof of an applicant address requirement. Remove this region criterion unless a separate applicant headquarters, address, or premises sentence exists.",
      });
    }
    if (
      item.criterion.dimension === "biz_age"
      && /source_field\s*:\s*biz_enyy/iu.test(context)
      && /예비창업/u.test(context)
      && (context.match(/\d+년\s*미만/gu)?.length ?? 0) >= 4
    ) {
      issues.push({
        code: "semantic_misattribution",
        path: `$.criteria[${item.index}]`,
        message:
          "A broad K-Startup biz_enyy category list is search metadata, not a global company-age requirement. Remove this biz_age criterion and use a concrete eligibility sentence if present.",
      });
    }
  }
}

function validateAlternativeApplicantPaths(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const targetLists = criteria.filter((item) => {
    if (
      item.criterion.dimension !== "target_type"
      || item.criterion.kind !== "required"
    ) return false;
    const span = (item.criterion.sourceSpan ?? "").normalize("NFKC");
    return (span.match(/,/g)?.length ?? 0) >= 2 || /및\s*기타/u.test(span);
  });
  for (const item of criteria) {
    if (item.criterion.kind !== "required") continue;
    const semantic = criterionSemanticText(item);
    if (
      item.criterion.dimension === "industry"
      && /(?:콘텐츠|영상|영화|제조|개발).{0,24}사업자.{0,60}(?:또는|혹은).{0,80}(?:개인\s*(?:창작자|신청자)|예비창업자)/u.test(semantic)
    ) {
      issues.push({
        code: "semantic_misattribution",
        path: `$.criteria[${item.index}]`,
        message:
          "An industry condition that applies only to one side of a business-or-individual applicant path cannot be published as a global industry requirement. Preserve the complete alternative as other/text_only.",
      });
      continue;
    }
    if (item.criterion.dimension !== "premises" && item.criterion.dimension !== "biz_age") {
      continue;
    }
    const candidate = normalizeComparableEvidence(item.criterion.sourceSpan);
    if (candidate.length < 5 || !/(?:기업|사업자|창업자)$/u.test(candidate)) continue;
    const containingTarget = targetLists.find((target) => {
      const whole = normalizeComparableEvidence(target.criterion.sourceSpan);
      return whole.length > candidate.length * 1.5 && whole.includes(candidate);
    });
    if (!containingTarget) continue;
    issues.push({
      code: "semantic_misattribution",
      path: `$.criteria[${item.index}]`,
      message:
        `This ${item.criterion.dimension} requirement is only one item in the alternative applicant list at $.criteria[${containingTarget.index}], not a global requirement. Remove the standalone criterion and preserve the complete OR path.`,
    });
  }
}

function criterionEvidenceContext(
  seal: DeepAnalysisInputSeal,
  item: DeepAnalysisValidatedCriterion,
): string {
  return item.evidenceRefs.map((ref) => {
    const chunk = seal.chunks.find((candidate) => candidate.id === ref.chunkId);
    if (!chunk) return "";
    const relativeStart = Math.max(0, ref.startChar - chunk.startChar);
    const relativeEnd = Math.max(relativeStart, ref.endChar - chunk.startChar);
    const lineStart = chunk.text.lastIndexOf("\n", relativeStart - 1) + 1;
    const nextBreak = chunk.text.indexOf("\n", relativeEnd);
    const lineEnd = nextBreak < 0 ? chunk.text.length : nextBreak;
    return chunk.text.slice(lineStart, lineEnd);
  }).join("\n").normalize("NFKC");
}

function validateProceduralEvidenceChecks(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    if (item.criterion.dimension !== "founder_trait") continue;
    const text = criterionSemanticText(item);
    if (!/외국인.{0,24}증명서.{0,40}유효기간.{0,24}확인/u.test(text)) continue;
    if (/(?:신청|지원)\s*(?:불가|제외)|탈락|유효기간.{0,12}(?:이상|이하|초과|미만)/u.test(text)) {
      continue;
    }
    issues.push({
      code: "semantic_misattribution",
      path: `$.criteria[${item.index}]`,
      message:
        "Checking a foreign-owner certificate's validity without an explicit pass/fail fact or threshold is an application procedure, not a founder_trait requirement.",
    });
  }
}

function validatePriorAwardLosslessScope(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  for (const item of criteria) {
    if (
      item.criterion.dimension !== "prior_award"
      || item.criterion.operator === "text_only"
    ) continue;
    const text = criterionSemanticText(item);
    const sameItem = /동일\s*\(?\s*유사\s*\)?\s*(?:아이템|과제|품목)/u.test(text);
    const calendarScope = /[’']?\d{2,4}\s*[~∼-]\s*[’']?\d{2,4}\s*년/u.test(text)
      || /[’']?\d{2,4}\s*년도?.{0,80}[’']?\d{2,4}\s*년도?/u.test(text);
    const nonCanonicalException = /(?:단|다만).{0,120}(?:참가|신청).{0,24}(?:가능|할\s*수)/u.test(text);
    if (!sameItem || (!calendarScope && !nonCanonicalException)) continue;
    issues.push({
      code: "canonical_contract_invalid",
      path: `$.criteria[${item.index}]`,
      message:
        "A same/similar-item prior-award rule with calendar-year scope or a non-canonical competition exception cannot be represented by programs/states alone; preserve the full exclusion as other/text_only.",
    });
  }
}

function validateEligibilityRankingSeparation(
  seal: DeepAnalysisInputSeal,
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const requiredBusinessAge = criteria.some((item) => (
    item.criterion.dimension === "biz_age" && item.criterion.kind === "required"
  ));
  const preferredBusinessAge = criteria.some((item) => (
    item.criterion.dimension === "biz_age" && item.criterion.kind === "preferred"
  ));
  if (!requiredBusinessAge || preferredBusinessAge) return;
  const text = sealedEvidenceText(seal);
  const keywordPattern = /(?:입주신청일\s*기준\s*창업일|업력)/gu;
  for (const match of text.matchAll(keywordPattern)) {
    const window = text.slice(match.index ?? 0, (match.index ?? 0) + 900);
    const scoreCount = window.match(/\d+(?:\.\d+)?\s*점/gu)?.length ?? 0;
    const tierCount = window.match(/\d+년\s*(?:이내|초과)/gu)?.length ?? 0;
    if (scoreCount < 3 || tierCount < 3) continue;
    issues.push({
      code: "high_risk_condition_gap",
      path: "$.criteria.biz_age",
      message:
        "The source contains multiple company-age scoring tiers, but only a required biz_age criterion was emitted. Keep the eligibility bound and emit the ranking tiers separately as preferred criteria.",
    });
    return;
  }
}

function validateHighRiskConditionCoverage(
  seal: DeepAnalysisInputSeal,
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const text = sealedEvidenceText(seal);
  const creditRule = /부도.{0,80}금융기관.{0,40}채무\s*불이행\s*중/u.test(text);
  if (creditRule) {
    const flags = new Set(criteria
      .filter((item) => item.criterion.dimension === "credit_status")
      .flatMap((item) => stringArray(
        isRecord(item.canonicalCriterion.value) ? item.canonicalCriterion.value.flags : [],
      )));
    const losslessText = criteria.some((item) => (
      item.criterion.dimension === "credit_status"
      && item.criterion.operator === "text_only"
      && /부도.{0,80}채무\s*불이행/u.test(criterionSemanticText(item))
    ));
    if (!losslessText && (!flags.has("bond_default") || !flags.has("loan_default"))) {
      issues.push({
        code: "high_risk_condition_gap",
        path: "$.criteria.credit_status",
        message:
          "The source explicitly excludes both bond default and financial-institution debt default, but the credit_status criteria do not preserve both conditions.",
      });
    }
  }

  const financialRulePattern = /부채\s*비율.{0,30}1[\s,]?000\s*%\s*이상.{0,80}(?:완전\s*자본\s*잠식|완전자본\s*잠식)/u;
  const financialRuleMatch = financialRulePattern.exec(text);
  if (financialRuleMatch) {
    const financialWindow = text.slice(
      financialRuleMatch.index,
      financialRuleMatch.index + financialRuleMatch[0].length + 240,
    );
    const hasNonCanonicalException = /(?:관리규정|규정).{0,40}예외\s*인정|예외\s*인정/u.test(financialWindow);
    const covered = criteria.some((item) => {
      if (item.criterion.dimension !== "financial_health") return false;
      if (item.criterion.operator === "text_only") {
        const semantic = criterionSemanticText(item);
        return /1[\s,]?000\s*%/u.test(semantic)
          && /완전\s*자본\s*잠식|완전자본\s*잠식/u.test(semantic)
          && (!hasNonCanonicalException || /예외/u.test(semantic));
      }
      if (hasNonCanonicalException) return false;
      const value = isRecord(item.canonicalCriterion.value) ? item.canonicalCriterion.value : {};
      const threshold = isRecord(value.debt_ratio_pct_threshold)
        ? value.debt_ratio_pct_threshold.value
        : null;
      return threshold === 1_000 && stringArray(value.impairment_excluded).includes("full");
    });
    if (!covered) {
      issues.push({
        code: "high_risk_condition_gap",
        path: "$.criteria.financial_health",
        message:
          "The source explicitly excludes debt ratio at or above 1000% or full capital impairment, but the financial_health criteria do not preserve both conditions and their exception scope.",
      });
    }
  }

  if (/추진\s*목적에\s*부합되지\s*않는\s*아이템/u.test(text)) {
    const covered = criteria.some((item) => (
      item.criterion.dimension === "other"
      && item.criterion.kind === "exclusion"
      && /추진\s*목적에\s*부합되지\s*않는\s*아이템/u.test(criterionSemanticText(item))
    ));
    if (!covered) {
      issues.push({
        code: "high_risk_condition_gap",
        path: "$.criteria.other",
        message:
          "The source explicitly excludes items that do not fit the competition purpose; preserve this application-impacting item-scope rule as other/text_only exclusion.",
      });
    }
  }
}

function sealedEvidenceText(seal: DeepAnalysisInputSeal): string {
  return seal.chunks.map((chunk) => chunk.text).join("\n").normalize("NFKC").replace(/\s+/g, " ");
}

function criterionSemanticText(item: DeepAnalysisValidatedCriterion): string {
  const valueNote = isRecord(item.criterion.value) && typeof item.criterion.value.note === "string"
    ? item.criterion.value.note
    : "";
  return `${item.criterion.sourceSpan ?? ""} ${item.criterion.note ?? ""} ${valueNote}`
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
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

const ROLE_LABELS = [
  "신청기업",
  "주관기업",
  "주관기관",
  "수혜기업",
  "도입기업",
  "제조기업",
  "수행기관",
  "전문기관",
  "공급기업",
  "디자인기업",
  "참여기관",
  "실증처",
] as const;

function criterionRoleLabels(item: DeepAnalysisValidatedCriterion): Set<string> {
  const text = `${item.criterion.sourceSpan ?? ""} ${item.criterion.note ?? ""} ${
    isRecord(item.criterion.value) && typeof item.criterion.value.note === "string"
      ? item.criterion.value.note
      : ""
  }`.normalize("NFKC").replace(/\s+/g, " ");
  return new Set(ROLE_LABELS.filter((label) => text.includes(label)));
}

/**
 * 같은 canonical criterion이 역할별 근거에서 반복되면 현재 matcher는 첫 행만 남겨
 * 역할 범위를 잃는다. 값이 같다는 이유만으로 수혜기업과 수행기업의 조건을 합치지 않는다.
 */
function validateScopedSemanticDuplicates(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const groups = new Map<string, DeepAnalysisValidatedCriterion[]>();
  for (const item of criteria) {
    const group = groups.get(item.semanticSha256) ?? [];
    group.push(item);
    groups.set(item.semanticSha256, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const roleSets = group.map(criterionRoleLabels);
    const roleSignatures = new Set(roleSets.map((roles) => [...roles].sort().join("|")));
    const allRoles = new Set(roleSets.flatMap((roles) => [...roles]));
    if (allRoles.size < 2 || roleSignatures.size < 2) continue;
    for (const duplicate of group.slice(1)) {
      issues.push({
        code: "semantic_duplicate",
        path: `$.criteria[${duplicate.index}]`,
        message:
          "The same structured value is repeated for different applicant/beneficiary/provider roles. Do not silently merge role scope; preserve the complete role-specific rule as other/text_only or emit one structured criterion only when it is unconditional for every applicant role.",
      });
    }
  }
}

const NON_APPLICANT_NOTE =
  /(?:지원기업|신청기업).{0,32}(?:요구되지\s*않|요건이\s*아니|적용되지\s*않|별도로\s*확인되지\s*않)|(?:주관기업|주관기관).{0,40}(?:수행기관|전문기관|참여기관|공급기업|디자인기업).{0,24}(?:유형|자격|요건)/u;
const TRACK_SCOPED_RULE =
  /(?:지원유형|세부\s*유형|트랙|분야).{0,28}(?:경우|한해|한하여|만\s*적용|기준)|(?:신청\s*시에만|경우에만\s*(?:가점|적용|지원))/u;

/**
 * 현재 matcher criterion에는 actor/track 필드가 없다. 그 범위를 잃은 구조화 값은
 * 다른 역할의 회사까지 자동 탈락·가점시킬 수 있으므로 text_only로 fail-closed 한다.
 */
function validateActorAndTrackScope(
  criteria: DeepAnalysisValidatedCriterion[],
  issues: DeepAnalysisValidationIssue[],
): void {
  const roleSplit = criteria.some((item) => criterionRoleLabels(item).size >= 2);
  for (const item of criteria) {
    if (item.criterion.operator === "text_only") continue;
    const span = (item.criterion.sourceSpan ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    const note = `${item.criterion.note ?? ""} ${
      isRecord(item.criterion.value) && typeof item.criterion.value.note === "string"
        ? item.criterion.value.note
        : ""
    }`.normalize("NFKC").replace(/\s+/g, " ").trim();
    const roles = criterionRoleLabels(item);
    const explicitlyNonApplicant = NON_APPLICANT_NOTE.test(note);
    const oneRoleInsideSplit = roleSplit
      && roles.size === 1
      && [...roles].some((role) => (
        role !== "신청기업" && role !== "주관기업" && role !== "주관기관"
      ));
    if (!explicitlyNonApplicant && !oneRoleInsideSplit && !TRACK_SCOPED_RULE.test(`${span} ${note}`)) {
      continue;
    }
    issues.push({
      code: "semantic_misattribution",
      path: `$.criteria[${item.index}]`,
      message:
        "A role- or track-scoped condition cannot be published as an unconditional structured company criterion because the matcher has no actor/track scope. Preserve the actor, track, alternatives, and full condition as other/text_only; use a structured criterion only if the source explicitly applies it to every applicant role.",
    });
  }
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
    const semanticNote = [
      criterion.note,
      typeof rawValue.note === "string" ? rawValue.note : null,
    ].filter((value): value is string => Boolean(value)).join(" ");
    if (
      rawValue.list_semantics === "closed"
      && targetTypeNoteRequiresOpenList(semanticNote)
    ) {
      issues.push({
        code: "semantic_misattribution",
        path: `$.criteria[${index}].value.list_semantics`,
        message:
          "target_type note says the applicant list is open or must not reject unlisted types, but value.list_semantics is closed. Preserve it as open or remove the contradictory note.",
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

function targetTypeNoteRequiresOpenList(note: string): boolean {
  const normalized = note.normalize("NFKC");
  return /list_semantics\s*=\s*open/iu.test(normalized)
    || /(?:열린|개방형|완전\s*열거가\s*아닌).{0,24}목록/iu.test(normalized)
    || /목록\s*밖.{0,40}(?:자동\s*)?탈락시키지/iu.test(normalized);
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
    criterion.dimension === "region"
    && /본사.{0,24}(?:관외|무관|외부)/u.test(span)
    && /(?:공장|사업장).{0,28}(?:관내|소재|지역)/u.test(span)
  ) {
    reject(
      "A current premises alternative allows an outside-region headquarters when the target factory/site is local; use region/text_only with the full headquarters-or-site path.",
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

  if (criterion.dimension === "financial_health") {
    const debtThreshold = isRecord(value.debt_ratio_pct_threshold)
      ? value.debt_ratio_pct_threshold
      : {};
    const hasDebtThreshold = typeof debtThreshold.value === "number";
    if (hasDebtThreshold && /부채\s*비율.{0,18}(?:이상|초과)/u.test(span) && criterion.operator !== "gte") {
      reject(
        "A debt-ratio lower boundary expressed as 이상/초과 requires operator=gte; exclusion kind does not reverse the numeric operator.",
        ".operator",
      );
    }
    if (hasDebtThreshold && /부채\s*비율.{0,18}(?:이하|미만)/u.test(span) && criterion.operator !== "lte") {
      reject(
        "A debt-ratio upper boundary expressed as 이하/미만 requires operator=lte; exclusion kind does not reverse the numeric operator.",
        ".operator",
      );
    }
    const hasUnrepresentedComposite = (
      /부채\s*비율/u.test(span)
      && /유동\s*비율/u.test(span)
      && /(?:또는|거나|or)/iu.test(span)
    ) || (
      /최근\s*\d+\s*년/u.test(span)
      && /연속/u.test(span)
    ) || (
      /(?:단|다만).{0,120}(?:예외|제외)/u.test(span)
    );
    if (hasDebtThreshold && hasUnrepresentedComposite) {
      reject(
        "A multi-year, liquidity-OR, or exception-qualified financial threshold is not losslessly representable; use financial_health/text_only with the complete predicate.",
        ".operator",
      );
    }
  }

  if (
    criterion.dimension === "credit_status"
    && /면책\s*권자인\s*경우/u.test(span)
  ) {
    reject(
      "Bankruptcy discharge wording cannot be reduced to bankruptcy/rehabilitation flags without preserving whether discharge is an exclusion or an exception; use credit_status/text_only.",
      ".operator",
    );
  }

  if (
    criterion.dimension === "founder_trait"
    && /여성\s*(?:종업원|근로자|직원|재직자)/u.test(span)
  ) {
    reject(
      "Female employee/workforce share is not a founder trait; preserve the workforce-scoped preference as other/text_only.",
      ".operator",
    );
  }

  if (criterion.dimension === "prior_award") {
    const selfKind = typeof value.self_kind === "string" ? value.self_kind : null;
    if (
      selfKind === "current_similar"
      && /(?:수혜\s*이력|과거\s*지원|기\s*지원|지원\s*내역)/u.test(span)
      && !/(?:현재|추진\s*중|수행\s*중|동시|중복\s*(?:참여|수행|지원))/u.test(span)
    ) {
      reject(
        "Past benefit/support history cannot be narrowed to current_similar; use same_business_prior when explicit or other/text_only when the history scope is unresolved.",
        ".value.self_kind",
      );
    }
    const states = stringArray(value.states);
    if (
      states.length === 1
      && states[0] === "participating"
      && /참여자\s*\(?사\)?/u.test(span)
      && !/(?:현재|참여\s*중|수행\s*중)/u.test(span)
    ) {
      reject(
        "Unqualified 참여자(사) history is not current-only; include both participating and completed states.",
        ".value.states",
      );
    }
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
