import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisAuditModel,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  analyzeSealedDeepAnalysisInput,
  type DeepAnalysisExecution,
} from "./analyzer";
import { adjudicateDeepAnalysisAudit } from "./auditAdjudication";
import type { runDeepGrantAnalysis } from "./extractor";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { repairDeepAnalysisExecution } from "./repair";
import {
  validateDeepAnalysisResult,
  type DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_AUDIT_PROMPT_VERSION = "deep-analysis-blind-audit-v2" as const;

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
    rawResponseText: string;
    rawToolInput: Record<string, unknown>;
    usage: { inputTokens: number; outputTokens: number } | null;
    costUsd: number | null;
  } | null;
}

/**
 * primary 결과를 모델 입력에 전달하지 않는다. source seal만 다른 allowlisted model로 독립
 * 분석한 뒤, 두 결과의 canonical semantic set과 22축 status를 서버가 비교한다.
 */
export async function runBlindDeepAnalysisAudit(input: {
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  auditModel: DeepAnalysisAuditModel;
  primaryValidation: DeepAnalysisValidationResult;
  primaryResult: DeepAnalysisModelResult;
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<DeepAnalysisBlindAuditResult> {
  let execution = await analyzeSealedDeepAnalysisInput({
    seal: input.seal,
    apiKey: input.apiKey,
    model: input.auditModel,
    ...(input.runModel ? { runModel: input.runModel } : {}),
  });
  let validation = validateDeepAnalysisResult({
    seal: input.seal,
    result: execution.result,
  });
  for (let repairAttempt = 0; repairAttempt < 2 && !validation.valid; repairAttempt += 1) {
    execution = await repairDeepAnalysisExecution({
      seal: input.seal,
      apiKey: input.apiKey,
      model: input.auditModel,
      failedExecution: execution,
      validation,
      ...(input.runModel ? { runModel: input.runModel } : {}),
    });
    validation = validateDeepAnalysisResult({
      seal: input.seal,
      result: execution.result,
    });
  }
  const comparison = compareDeepAnalysisValidations({
    primary: input.primaryValidation,
    primaryResult: input.primaryResult,
    audit: validation,
    auditResult: execution.result,
  });
  const adjudication = validation.valid && comparison.verdict !== "concur"
    ? await adjudicateDeepAnalysisAudit({
      apiKey: input.apiKey,
      model: input.auditModel,
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
    verdict: validation.valid
      ? adjudication?.verdict ?? comparison.verdict
      : "unsure",
    itemResults: adjudication?.itemResults ?? comparison.itemResults,
    validation,
    execution,
    adjudication: adjudication
      ? {
        rawResponseText: adjudication.rawResponseText,
        rawToolInput: adjudication.rawToolInput,
        usage: adjudication.usage,
        costUsd: adjudication.costUsd,
      }
      : null,
  };
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
