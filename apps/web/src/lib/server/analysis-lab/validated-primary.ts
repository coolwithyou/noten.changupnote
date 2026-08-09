import type { DeepAnalysisModelPass } from "@/lib/server/deep-analysis/analyzer";
import type { DeepAnalysisEffort, DeepAnalysisModelResult } from "@cunote/contracts";
import { repairDeepAnalysisExecution } from "@/lib/server/deep-analysis/repair";
import { runDeepGrantAnalysis } from "@/lib/server/deep-analysis/extractor";
import { sealDeepAnalysisInput } from "@/lib/server/deep-analysis/inputManifest";
import { validateDeepAnalysisResult } from "@/lib/server/deep-analysis/validator";

const MAX_LAB_PRIMARY_REPAIRS = 2;

export interface ValidatedLabPrimaryResult {
  extraction: DeepAnalysisModelResult;
  repairCount: number;
}

/**
 * 로컬 구독 lab도 운영 worker와 같은 validator→repair 계약을 통과해야 성공한다.
 * lab 입력 전체를 하나의 synthetic structured source로 봉인해 기존 원문 substring 계약을
 * 그대로 검증하고, 교정 호출에도 최초 transport의 fetch 구현을 관통시킨다.
 */
export async function runValidatedLabPrimary(input: {
  grantId: string;
  inputText: string;
  inputSha256: string;
  apiKey: string;
  model: string;
  effort?: DeepAnalysisEffort | null;
  fetchImpl?: typeof fetch;
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<ValidatedLabPrimaryResult> {
  const seal = sealDeepAnalysisInput({
    grantId: input.grantId,
    sourceRevisionSha256: input.inputSha256,
    structuredText: input.inputText,
    attachments: [],
  });
  const runModel = input.runModel ?? ((options) => runDeepGrantAnalysis({
    ...options,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  }));
  const first = await runModel({
    apiKey: input.apiKey,
    inputText: input.inputText,
    evidenceText: input.inputText,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });
  const firstPass: DeepAnalysisModelPass = {
    kind: "single",
    chunkId: null,
    inputChars: input.inputText.length,
    result: first,
  };
  let execution = {
    result: first,
    passes: [firstPass],
    evidenceText: input.inputText,
  };
  let validation = validateDeepAnalysisResult({ seal, result: execution.result });
  let repairCount = 0;
  while (!validation.valid && repairCount < MAX_LAB_PRIMARY_REPAIRS) {
    execution = await repairDeepAnalysisExecution({
      seal,
      apiKey: input.apiKey,
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      failedExecution: execution,
      validation,
      runModel,
    });
    repairCount += 1;
    validation = validateDeepAnalysisResult({ seal, result: execution.result });
  }
  if (!validation.valid) {
    const issues = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join(", ");
    throw new Error(
      `로컬 딥분석이 validator 교정 ${repairCount}회 뒤에도 실패했습니다: ${issues}`,
    );
  }
  return { extraction: execution.result, repairCount };
}

