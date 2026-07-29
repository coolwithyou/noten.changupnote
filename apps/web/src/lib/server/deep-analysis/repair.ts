import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
  type DeepAnalysisUsage,
  type GrantCriterion,
} from "@cunote/contracts";
import type { DeepAnalysisAuditAcceptedFinding } from "./auditAdjudication";
import type {
  DeepAnalysisExecution,
  DeepAnalysisModelPass,
} from "./analyzer";
import { sumDeepAnalysisActualCosts } from "./costPolicy";
import {
  findExactEvidenceSpanCandidates,
  runDeepGrantAnalysis,
} from "./extractor";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { stableJson } from "./sourceRevision";
import type { DeepAnalysisValidationResult } from "./validator";

export const DEEP_ANALYSIS_REPAIR_VERSION = "deep-analysis-repair-v2" as const;
export const DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION =
  "deep-analysis-audit-retry-feedback-v1" as const;

export interface DeepAnalysisEvidenceRepairHint {
  issuePath: string;
  criterionIndex: number;
  requestedSourceSpan: string;
  exactCandidates: string[];
  candidateCount: number;
  truncated: boolean;
}

export interface DeepAnalysisAuditRetryFeedback {
  version: typeof DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION;
  previousRunId: string;
  auditArtifactKey: string;
  findings: DeepAnalysisAuditAcceptedFinding[];
  taskInstruction: string;
}

const MAX_EVIDENCE_REPAIR_CANDIDATES = 8;

/**
 * 사람이 dead-letter 작업을 명시적으로 재처리할 때, 직전 독립 감사에서 결정론적으로
 * 검증된 blocker만 다음 primary의 교정 맥락으로 돌려준다. 자유서술 disagreement나
 * uncertainty는 포함하지 않아 검수 모델의 추측이 primary에 학습되는 것을 막는다.
 */
export function buildDeepAnalysisAuditRetryFeedback(input: {
  previousRunId: string;
  auditArtifactKey: string;
  artifactText: string;
}): DeepAnalysisAuditRetryFeedback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.artifactText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schema !== "deep-analysis-blind-audit-v7") return null;
  const adjudication = isRecord(parsed.adjudication) ? parsed.adjudication : null;
  const findingValidation = adjudication && isRecord(adjudication.findingValidation)
    ? adjudication.findingValidation
    : null;
  if (!findingValidation || !Array.isArray(findingValidation.accepted)) return null;
  const findings = findingValidation.accepted
    .map(parseAcceptedAuditFinding)
    .filter((finding): finding is DeepAnalysisAuditAcceptedFinding => finding !== null);
  if (findings.length === 0 || findings.length !== findingValidation.accepted.length) return null;
  const taskInstruction = [
    "이 실행은 관리자가 명시적으로 재처리한 동일 봉인 입력이다.",
    "직전 독립 감사와 결정론적 검증기가 아래 누락·오분류를 blocking finding으로 확정했다.",
    "각 finding의 source_span을 현재 원문에서 다시 확인하고, 원문이 그대로 뒷받침하면 해당 criterion과 axis 상태를 완전한 22축 결과에 반영하라.",
    "원문 밖 내용을 추가하거나 uncertainty·rejected finding을 교정 사실로 사용하지 마라.",
    "<<<VERIFIED_AUDIT_FINDINGS>>>",
    stableJson(findings),
    "<<<END_VERIFIED_AUDIT_FINDINGS>>>",
  ].join("\n");
  return {
    version: DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION,
    previousRunId: input.previousRunId,
    auditArtifactKey: input.auditArtifactKey,
    findings,
    taskInstruction,
  };
}

/**
 * validator를 완화하지 않고 실패 사유를 primary model에 1회 되돌려 완전한 결과를 다시 받는다.
 * 교정 응답도 raw pass와 비용에 합산하며, 이후 동일 validator를 처음부터 다시 적용한다.
 */
export async function repairDeepAnalysisExecution(input: {
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  model: string;
  effort?: DeepAnalysisEffort | null;
  failedExecution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<DeepAnalysisExecution> {
  const runModel = input.runModel ?? runDeepGrantAnalysis;
  const evidenceRepairHints = buildDeepAnalysisEvidenceRepairHints({
    execution: input.failedExecution,
    validation: input.validation,
  });
  const repairInput = [
    input.failedExecution.evidenceText,
    "",
    "<<<FAILED_RESULT_TO_REPAIR>>>",
    stableJson({
      result: stripRaw(input.failedExecution.result),
      validatorIssues: input.validation.issues,
      evidenceRepairHints,
    }),
    "<<<END_FAILED_RESULT_TO_REPAIR>>>",
  ].join("\n");
  const repaired = await runModel({
    apiKey: input.apiKey,
    inputText: repairInput,
    evidenceText: input.failedExecution.evidenceText,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    taskInstruction: [
      "아래 원문과 직전 결과의 validator 실패 사유를 읽고 전체 22축 결과를 교정해서 다시 반환하라.",
      "validator 지적을 삭제하거나 무시하지 말고 원문 근거로 해결하라.",
      "criterion이 있는 축은 반드시 condition_found, condition_found 축은 criterion 1개 이상이어야 한다.",
      "ambiguous는 원문을 모두 읽어도 found/no_condition을 정말 결정할 수 없을 때만 사용한다.",
      "모든 source_span은 원문 영역에서 공백과 문장부호까지 글자 그대로 복사한다.",
      "evidenceRepairHints가 있는 source_span 오류는 해당 exactCandidates 중 criterion을 충분히 뒷받침하는 가장 짧은 후보 하나를 한 글자도 바꾸지 말고 사용하며, 서로 다른 후보를 합치거나 다시 쓰지 마라.",
      "axis_criterion_mismatch에서 실제 조건이 있으면 같은 축 criterion을 만들고 condition_found를 유지하며, 실제 조건이 없으면 criterion을 만들지 말고 inspected_no_condition으로 고쳐라.",
      "직전 결과 일부만 패치하지 말고 완전한 tool 결과 전체를 다시 반환한다.",
    ].join(" "),
  });
  const repairPass: DeepAnalysisModelPass = {
    kind: "repair",
    chunkId: null,
    inputChars: repairInput.length,
    result: repaired,
  };
  const passes = [...input.failedExecution.passes, repairPass];
  return {
    evidenceText: input.failedExecution.evidenceText,
    passes,
    result: {
      ...repaired,
      usage: sumUsage(passes.map((pass) => pass.result.usage)),
      costUsd: sumDeepAnalysisActualCosts(passes.map((pass) => pass.result.costUsd)),
    },
  };
}

export function buildDeepAnalysisEvidenceRepairHints(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): DeepAnalysisEvidenceRepairHint[] {
  const hints: DeepAnalysisEvidenceRepairHint[] = [];
  for (const issue of input.validation.issues) {
    if (issue.code !== "evidence_not_grounded") continue;
    const match = /^\$\.criteria\[(\d+)\]\.source_span$/.exec(issue.path);
    if (!match) continue;
    const criterionIndex = Number.parseInt(match[1]!, 10);
    const requestedSourceSpan =
      input.execution.result.criteria[criterionIndex]?.sourceSpan?.trim() ?? "";
    if (!requestedSourceSpan) continue;
    const candidates = findExactEvidenceSpanCandidates(
      requestedSourceSpan,
      input.execution.evidenceText,
    );
    if (candidates.length === 0) continue;
    hints.push({
      issuePath: issue.path,
      criterionIndex,
      requestedSourceSpan,
      exactCandidates: candidates.slice(0, MAX_EVIDENCE_REPAIR_CANDIDATES),
      candidateCount: candidates.length,
      truncated: candidates.length > MAX_EVIDENCE_REPAIR_CANDIDATES,
    });
  }
  return hints;
}

function stripRaw(result: DeepAnalysisModelResult) {
  const { rawResponseText: _response, rawToolInput: _input, ...value } = result;
  return value;
}

function parseAcceptedAuditFinding(value: unknown): DeepAnalysisAuditAcceptedFinding | null {
  if (!isRecord(value)) return null;
  const candidateKey = typeof value.candidateKey === "string" ? value.candidateKey : "";
  const dimension = isCriterionDimension(value.dimension) ? value.dimension : null;
  const findingType = value.findingType;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const criterion = parseGrantCriterion(value.criterion);
  if (
    !/^[0-9a-f]{64}$/.test(candidateKey)
    || !dimension
    || (findingType !== "missing_eligibility" && findingType !== "misclassified_eligibility")
    || !reason
    || !criterion
    || criterion.dimension !== dimension
  ) {
    return null;
  }
  return {
    candidateKey,
    dimension,
    findingType,
    reason,
    criterion,
  };
}

function parseGrantCriterion(value: unknown): GrantCriterion | null {
  if (
    !isRecord(value)
    || !isCriterionDimension(value.dimension)
    || typeof value.operator !== "string"
    || typeof value.kind !== "string"
    || !("value" in value)
    || typeof value.confidence !== "number"
    || typeof value.source_span !== "string"
    || value.source_span.trim().length === 0
  ) {
    return null;
  }
  return value as unknown as GrantCriterion;
}

function isCriterionDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string"
    && CRITERION_DIMENSIONS.includes(value as CriterionDimension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sumUsage(values: Array<DeepAnalysisUsage | null>): DeepAnalysisUsage | null {
  const present = values.filter((value): value is DeepAnalysisUsage => value !== null);
  if (present.length === 0) return null;
  const cache = present.map((value) => value.cacheReadTokens);
  return {
    inputTokens: present.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: present.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: cache.every((value) => value === null)
      ? null
      : cache.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  };
}
