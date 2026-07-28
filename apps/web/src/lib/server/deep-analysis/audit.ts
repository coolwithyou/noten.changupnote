import {
  CRITERION_DIMENSIONS,
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
import type { DeepAnalysisInputSeal } from "./inputManifest";
import {
  validateDeepAnalysisResult,
  type DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_AUDIT_PROMPT_VERSION = "deep-analysis-blind-audit-v14" as const;
export const DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION = [
  "이 실행은 primary를 보지 않는 독립 감사 분석이다.",
  "신청자격·결격·우대·평가점수에 직접 영향을 주는 criterion 후보만 반환하라.",
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
  let execution = await analyzeSealedDeepAnalysisInput({
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
  let validation = validateDeepAnalysisResult({
    seal: input.seal,
    result: execution.result,
  });
  const comparison = compareDeepAnalysisValidations({
    primary: input.primaryValidation,
    primaryResult: input.primaryResult,
    audit: validation,
    auditResult: execution.result,
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
      auditResult: execution.result,
      auditValidation: validation,
    })
    : null;
  return {
    promptVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
    contractVersion: DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
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
  primaryResult: DeepAnalysisModelResult | null;
  audit: DeepAnalysisValidationResult;
  auditResult: DeepAnalysisModelResult;
}): {
  verdict: DeepAnalysisAuditVerdict;
  itemResults: DeepAnalysisAuditItemResult[];
} {
  const itemResults: DeepAnalysisAuditItemResult[] = [];
  const primaryAxes = input.primaryResult
    ? new Map(input.primaryResult.axisAssessments.map((axis) => [axis.dimension, axis.status]))
    : deriveAxisStatusFromValidation(input.primary);
  const auditAxes = new Map(
    input.auditResult.axisAssessments.map((axis) => [axis.dimension, axis.status]),
  );
  for (const dimension of CRITERION_DIMENSIONS) {
    const primary = primaryAxes.get(dimension) ?? null;
    const audit = auditAxes.get(dimension) ?? null;
    itemResults.push({
      kind: "axis",
      dimension,
      key: dimension,
      primary,
      audit,
      verdict: primary === audit ? "concur" : "disagree",
    });
    const primaryHashes = new Set(input.primary.axisCriterionSemanticHashes[dimension]);
    const auditHashes = new Set(input.audit.axisCriterionSemanticHashes[dimension]);
    for (const hash of [...new Set([...primaryHashes, ...auditHashes])].sort()) {
      const inPrimary = primaryHashes.has(hash);
      const inAudit = auditHashes.has(hash);
      itemResults.push({
        kind: "criterion",
        dimension,
        key: hash,
        primary: inPrimary ? hash : null,
        audit: inAudit ? hash : null,
        verdict: inPrimary && inAudit ? "concur" : "disagree",
      });
    }
  }
  return {
    verdict: input.primary.valid
      && input.audit.valid
      && itemResults.every((item) => item.verdict === "concur")
      ? "concur"
      : "disagree",
    itemResults,
  };
}

/**
 * primary result를 audit 실행 함수에 저장하지 않아도 criteria 보유 여부로 축 상태를 복원할
 * 수 있다. 빈 축은 validation을 통과한 경우 inspected_no_condition이다.
 */
function deriveAxisStatusFromValidation(
  validation: DeepAnalysisValidationResult,
): Map<CriterionDimension, string> {
  return new Map(CRITERION_DIMENSIONS.map((dimension) => [
    dimension,
    validation.axisCriterionSemanticHashes[dimension].length > 0
      ? "condition_found"
      : "inspected_no_condition",
  ]));
}
