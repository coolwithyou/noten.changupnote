import {
  type CriterionDimension,
  type DeepAnalysisAdjudicationModel,
  type DeepAnalysisAuditModel,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  analyzeSealedDeepAnalysisInput,
  type DeepAnalysisExecution,
} from "./analyzer";
import {
  DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
  runDeepGrantAuditAnalysis,
} from "./auditExtractor";
import {
  adjudicateDeepAnalysisAudit,
  type DeepAnalysisAuditFindingValidation,
  type DeepAnalysisAuditUncertaintyValidation,
} from "./auditAdjudication";
import {
  assessDeepAnalysisMatchImpactingAuditScope,
  DEEP_ANALYSIS_AUDIT_SCOPE_VERSION,
  isDeepAnalysisMatchImpactingCriterion,
} from "./auditScope";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import {
  validateDeepAnalysisResult,
  type DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_AUDIT_PROMPT_VERSION = "deep-analysis-blind-audit-v21" as const;
export const DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION = [
  "이 실행은 primary를 보지 않는 독립 감사 분석이다.",
  "신청 가능 여부를 바꾸는 required·exclusion·결격 예외 criterion 후보만 반환하라.",
  "우대·가점·평가점수 preferred 후보는 반환하지 마라.",
  "조건이 없는 축을 나타내는 행과 axis_assessments, 분석문, program_intent, taxonomy_proposals는 출력하지 마라.",
  "각 후보는 evidence catalog의 primary_source_ref를 하나 선택하고 source_span 문자열을 직접 만들지 마라.",
].join(" ");

export type DeepAnalysisAuditVerdict = "concur" | "disagree" | "unsure";

export interface DeepAnalysisAuditItemResult {
  kind: "axis" | "criterion";
  dimension: CriterionDimension;
  key: string;
  primary: string | null;
  audit: string | null;
  verdict: "concur" | "disagree";
  reason?: string | null;
}

export interface DeepAnalysisBlindAuditResult {
  promptVersion: typeof DEEP_ANALYSIS_AUDIT_PROMPT_VERSION;
  contractVersion: typeof DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION;
  scopeVersion: typeof DEEP_ANALYSIS_AUDIT_SCOPE_VERSION;
  model: DeepAnalysisAuditModel;
  verdict: DeepAnalysisAuditVerdict;
  itemResults: DeepAnalysisAuditItemResult[];
  validation: DeepAnalysisValidationResult;
  execution: DeepAnalysisExecution;
  adjudicationDisposition: "not_needed" | "audit_invalid" | "completed";
  adjudication: {
    model: DeepAnalysisAdjudicationModel;
    effort: DeepAnalysisEffort;
    rawResponseText: string;
    rawToolInput: Record<string, unknown>;
    findingValidation: DeepAnalysisAuditFindingValidation;
    uncertaintyValidation: DeepAnalysisAuditUncertaintyValidation;
    usage: { inputTokens: number; outputTokens: number } | null;
    costUsd: number | null;
  } | null;
}

/**
 * 첫 pass에는 primary 결과를 전달하지 않는다. source seal만 다른 allowlisted model로
 * 독립 분석해 누락 후보를 찾는다. blind 결과가 validator를 통과한 상태에서 exact 배열이
 * 다를 때만 원문을 다시 보는 semantic adjudication이 primary의 실제 의미 누락·오분류를
 * 판정한다. 계약이 불완전한 blind 결과는 자동 해석하지 않고 사람 검토로 닫는다.
 */
export async function runBlindDeepAnalysisAudit(input: {
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  auditModel: DeepAnalysisAuditModel;
  auditEffort: DeepAnalysisEffort | null;
  adjudicationModel: DeepAnalysisAdjudicationModel;
  adjudicationEffort: DeepAnalysisEffort;
  primaryValidation: DeepAnalysisValidationResult;
  primaryResult: DeepAnalysisModelResult;
  runAuditModel?: typeof runDeepGrantAuditAnalysis;
}): Promise<DeepAnalysisBlindAuditResult> {
  const execution = await analyzeSealedDeepAnalysisInput({
    seal: input.seal,
    apiKey: input.apiKey,
    model: input.auditModel,
    effort: input.auditEffort,
    taskInstruction: DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION,
    mapTaskInstruction: [
      "이 입력은 전체 공고를 무손실 분할한 한 chunk다.",
      "이 chunk에서 직접 확인되는 criterion 후보만 반환하고 다른 chunk 내용을 추정하지 마라.",
      "조건이 없으면 빈 criteria 배열을 반환하며 부재 상태를 나타내는 행은 만들지 마라.",
    ].join(" "),
    synthesisTaskInstruction: [
      "아래에는 같은 공고의 chunk별 criterion 후보가 있다.",
      "중복 후보를 합치고 공고 전체의 최종 criterion 후보만 반환하라.",
      "각 후보의 primary_source_ref와 supporting_source_refs는 chunk 결과에 있는 ID만 재사용하라.",
      "축 상태나 조건 부재 행은 출력하지 마라.",
    ].join(" "),
    runModel: input.runAuditModel ?? runDeepGrantAuditAnalysis,
  });
  const validation = validateDeepAnalysisAuditResult({
    seal: input.seal,
    result: execution.result,
  });
  const comparison = compareDeepAnalysisValidations({
    primary: input.primaryValidation,
    audit: validation,
  });
  const adjudication = shouldRunSemanticAuditAdjudication({
    primaryValid: input.primaryValidation.valid,
    auditValid: validation.valid,
    comparisonVerdict: comparison.verdict,
  })
    ? await adjudicateDeepAnalysisAudit({
      apiKey: input.apiKey,
      model: input.adjudicationModel,
      effort: input.adjudicationEffort,
      evidenceText: execution.evidenceText,
      primaryResult: input.primaryResult,
      primaryValidation: input.primaryValidation,
      auditValidation: validation,
    })
    : null;
  return {
    promptVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
    contractVersion: DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
    scopeVersion: DEEP_ANALYSIS_AUDIT_SCOPE_VERSION,
    model: input.auditModel,
    verdict: resolveSemanticAuditVerdict({
      auditValid: validation.valid,
      comparisonVerdict: comparison.verdict,
      adjudicationVerdict: adjudication?.verdict ?? null,
    }),
    itemResults: adjudication?.itemResults ?? comparison.itemResults,
    validation,
    execution,
    adjudicationDisposition: !validation.valid
      ? "audit_invalid"
      : adjudication
        ? "completed"
        : "not_needed",
    adjudication: adjudication
      ? {
        model: adjudication.model,
        effort: adjudication.effort,
        rawResponseText: adjudication.rawResponseText,
        rawToolInput: adjudication.rawToolInput,
        findingValidation: adjudication.findingValidation,
        uncertaintyValidation: adjudication.uncertaintyValidation,
        usage: adjudication.usage,
        costUsd: adjudication.costUsd,
      }
      : null,
  };
}

export function shouldRunSemanticAuditAdjudication(input: {
  primaryValid: boolean;
  auditValid: boolean;
  comparisonVerdict: DeepAnalysisAuditVerdict;
}): boolean {
  return input.primaryValid
    && input.auditValid
    && input.comparisonVerdict !== "concur";
}

export function resolveSemanticAuditVerdict(input: {
  auditValid: boolean;
  comparisonVerdict: DeepAnalysisAuditVerdict;
  adjudicationVerdict: DeepAnalysisAuditVerdict | null;
}): DeepAnalysisAuditVerdict {
  if (!input.auditValid) return "unsure";
  if (input.adjudicationVerdict) return input.adjudicationVerdict;
  return input.comparisonVerdict;
}

export function compareDeepAnalysisValidations(input: {
  primary: DeepAnalysisValidationResult;
  audit: DeepAnalysisValidationResult;
}): {
  verdict: DeepAnalysisAuditVerdict;
  itemResults: DeepAnalysisAuditItemResult[];
} {
  const scope = assessDeepAnalysisMatchImpactingAuditScope({
    primary: input.primary,
    audit: input.audit,
  });
  const itemResults: DeepAnalysisAuditItemResult[] = [
    ...scope.claimReviews.map((claim): DeepAnalysisAuditItemResult => ({
      kind: "criterion",
      dimension: claim.dimension,
      key: claim.key,
      primary: claim.key,
      audit: claim.verdict === "supported" ? claim.key : null,
      verdict: claim.verdict === "supported" ? "concur" : "disagree",
      reason: claim.verdict === "supported"
        ? null
        : "독립 audit에서 같은 match-impacting claim을 확인하지 못했습니다.",
    })),
    ...scope.missingCandidates.map((candidate): DeepAnalysisAuditItemResult => ({
      kind: "criterion",
      dimension: candidate.dimension,
      key: candidate.key,
      primary: null,
      audit: candidate.key,
      verdict: "disagree",
      reason: "독립 audit가 primary에 없는 match-impacting 후보를 확인했습니다.",
    })),
  ];
  return {
    verdict: input.primary.valid
      && input.audit.valid
      && !scope.requiresAdjudication
      ? "concur"
      : "disagree",
    itemResults,
  };
}

/**
 * Audit tool schema가 preferred를 허용하지 않더라도 외부 응답을 신뢰하지 않는다.
 * 범위를 벗어난 후보는 조용히 버리지 않고 audit contract 오류로 닫는다.
 */
export function validateDeepAnalysisAuditResult(input: {
  seal: DeepAnalysisInputSeal;
  result: DeepAnalysisModelResult;
}): DeepAnalysisValidationResult {
  const validation = validateDeepAnalysisResult(input);
  const outOfScope = validation.criteria.filter((item) => (
    !isDeepAnalysisMatchImpactingCriterion(item.canonicalCriterion)
  ));
  if (outOfScope.length === 0) return validation;
  return {
    ...validation,
    valid: false,
    responseContractValid: false,
    issues: [
      ...validation.issues,
      ...outOfScope.map((item) => ({
        code: "raw_contract_invalid" as const,
        path: `$.criteria[${item.index}].kind`,
        message: "Audit criteria must be required or exclusion; preferred is outside the match-impacting audit scope.",
      })),
    ],
  };
}
