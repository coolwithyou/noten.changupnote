import type {
  DeepAnalysisEffort,
  DeepAnalysisModelResult,
  DeepAnalysisUsage,
} from "@cunote/contracts";
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

export interface DeepAnalysisEvidenceRepairHint {
  issuePath: string;
  criterionIndex: number;
  requestedSourceSpan: string;
  exactCandidates: string[];
  candidateCount: number;
  truncated: boolean;
}

const MAX_EVIDENCE_REPAIR_CANDIDATES = 8;

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
