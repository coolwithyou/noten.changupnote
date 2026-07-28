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
import { adjudicateDeepAnalysisAudit } from "./auditAdjudication";
import type { runDeepGrantAnalysis } from "./extractor";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import {
  validateDeepAnalysisResult,
  type DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_AUDIT_PROMPT_VERSION = "deep-analysis-blind-audit-v12" as const;
export const DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION = [
  "이 실행은 primary를 보지 않는 독립 감사 분석이다.",
  "tool 결과에서 criteria와 정확히 22개의 axis_assessments를 가장 먼저 완성하라.",
  "analysis_markdown은 필수 제목을 유지하되 제목별 한 문장, 전체 1,200자 이내로 간결하게 쓴다.",
  "program_intent 각 필드는 한 문장 또는 짧은 목록으로 쓰고 taxonomy_proposals는 명백한 반복 신규축이 없으면 빈 배열로 둔다.",
  "설명 분량보다 신청자격·결격·우대·평가점수의 빠짐없는 구조화와 exact source_span을 우선한다.",
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
  model: DeepAnalysisAuditModel;
  verdict: DeepAnalysisAuditVerdict;
  itemResults: DeepAnalysisAuditItemResult[];
  validation: DeepAnalysisValidationResult;
  execution: DeepAnalysisExecution;
  adjudication: {
    model: DeepAnalysisAdjudicationModel;
    effort: DeepAnalysisEffort;
    rawResponseText: string;
    rawToolInput: Record<string, unknown>;
    usage: { inputTokens: number; outputTokens: number } | null;
    costUsd: number | null;
  } | null;
}

/**
 * 첫 pass에는 primary 결과를 전달하지 않는다. source seal만 다른 allowlisted model로
 * 독립 분석해 누락 후보를 찾고, exact 배열이 다르거나 blind 결과 계약이 불완전하면
 * 원문을 다시 보는 semantic adjudication이 primary의 실제 의미 누락·오분류만 판정한다.
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
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<DeepAnalysisBlindAuditResult> {
  let execution = await analyzeSealedDeepAnalysisInput({
    seal: input.seal,
    apiKey: input.apiKey,
    model: input.auditModel,
    effort: input.auditEffort,
    taskInstruction: DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION,
    ...(input.runModel ? { runModel: input.runModel } : {}),
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
    model: input.auditModel,
    verdict: resolveSemanticAuditVerdict({
      auditValid: validation.valid,
      comparisonVerdict: comparison.verdict,
      adjudicationVerdict: adjudication?.verdict ?? null,
    }),
    itemResults: adjudication?.itemResults ?? comparison.itemResults,
    validation,
    execution,
    adjudication: adjudication
      ? {
        model: adjudication.model,
        effort: adjudication.effort,
        rawResponseText: adjudication.rawResponseText,
        rawToolInput: adjudication.rawToolInput,
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
    && (!input.auditValid || input.comparisonVerdict !== "concur");
}

export function resolveSemanticAuditVerdict(input: {
  auditValid: boolean;
  comparisonVerdict: DeepAnalysisAuditVerdict;
  adjudicationVerdict: DeepAnalysisAuditVerdict | null;
}): DeepAnalysisAuditVerdict {
  if (input.adjudicationVerdict) return input.adjudicationVerdict;
  return input.auditValid ? input.comparisonVerdict : "unsure";
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
