import type { DeepAnalysisModelPass } from "@/lib/server/deep-analysis/analyzer";
import type { DeepAnalysisEffort, DeepAnalysisModelResult } from "@cunote/contracts";
import { repairDeepAnalysisExecution } from "@/lib/server/deep-analysis/repair";
import { runDeepGrantAnalysis } from "@/lib/server/deep-analysis/extractor";
import { sealDeepAnalysisInput } from "@/lib/server/deep-analysis/inputManifest";
import {
  type DeepAnalysisValidationIssue,
  validateDeepAnalysisResult,
} from "@/lib/server/deep-analysis/validator";

const MAX_LAB_PRIMARY_REPAIRS = 2;
/** 패스당 issue 코드 기록 상한 — 폭주 방어. dedupe는 하지 않는다(반복 빈도가 진단 정보). */
const MAX_PASS_ISSUE_CODES = 20;

export interface ValidatedLabPrimaryResult {
  extraction: DeepAnalysisModelResult;
  repairCount: number;
  /**
   * 패스별 validator 계측(2026-08-11 T4 1단계) — 어떤 issue 가 첫 패스를 떨어뜨리는지 진단용.
   * issueCodes 는 그 패스 결과의 validation 이슈 코드(빈 배열 = 그 패스로 통과).
   */
  passes: Array<{ kind: "primary" | "repair"; durationMs: number; issueCodes: string[] }>;
}

/** 패스 직후 validation 이슈 코드를 앞 N개까지 수집한다. */
function collectPassIssueCodes(issues: readonly DeepAnalysisValidationIssue[]): string[] {
  return issues.slice(0, MAX_PASS_ISSUE_CODES).map((issue) => issue.code);
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
  taskInstruction?: string;
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
  const passes: ValidatedLabPrimaryResult["passes"] = [];
  const firstStartedAt = Date.now();
  const first = await runModel({
    apiKey: input.apiKey,
    inputText: input.inputText,
    evidenceText: input.inputText,
    model: input.model,
    ...(input.taskInstruction ? { taskInstruction: input.taskInstruction } : {}),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });
  const firstDurationMs = Date.now() - firstStartedAt;
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
  passes.push({
    kind: "primary",
    durationMs: firstDurationMs,
    issueCodes: collectPassIssueCodes(validation.issues),
  });
  let repairCount = 0;
  while (!validation.valid && repairCount < MAX_LAB_PRIMARY_REPAIRS) {
    // 결정적 교정만으로 끝나면 수 ms — 그 자체가 "모델 repair 없이 해결" 신호라 그대로 기록한다.
    const repairStartedAt = Date.now();
    execution = await repairDeepAnalysisExecution({
      seal,
      apiKey: input.apiKey,
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      failedExecution: execution,
      validation,
      runModel,
    });
    const repairDurationMs = Date.now() - repairStartedAt;
    repairCount += 1;
    validation = validateDeepAnalysisResult({ seal, result: execution.result });
    passes.push({
      kind: "repair",
      durationMs: repairDurationMs,
      issueCodes: collectPassIssueCodes(validation.issues),
    });
  }
  if (!validation.valid) {
    const issues = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join(", ");
    // 최종 실패 throw 는 passes 를 싣지 않는다 — v1 계측 범위는 성공 런 한정.
    throw new Error(
      `로컬 딥분석이 validator 교정 ${repairCount}회 뒤에도 실패했습니다: ${issues}`,
    );
  }
  return { extraction: execution.result, repairCount, passes };
}
