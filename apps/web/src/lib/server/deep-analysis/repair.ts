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
import { runDeepGrantAnalysis } from "./extractor";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { stableJson } from "./sourceRevision";
import type { DeepAnalysisValidationResult } from "./validator";

export const DEEP_ANALYSIS_REPAIR_VERSION = "deep-analysis-repair-v1" as const;

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
  const repairInput = [
    input.failedExecution.evidenceText,
    "",
    "<<<FAILED_RESULT_TO_REPAIR>>>",
    stableJson({
      result: stripRaw(input.failedExecution.result),
      validatorIssues: input.validation.issues,
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
