import type { DeepAnalysisModelPass } from "@/lib/server/deep-analysis/analyzer";
import type { DeepAnalysisEffort, DeepAnalysisModelResult } from "@cunote/contracts";
import type {
  LabPrimaryPassDiagnostic,
  LabPrimaryPassIssue,
  LabPrimaryRepairProvenance,
} from "@/features/dev/analysis-lab/contract";
import { repairDeepAnalysisExecution } from "@/lib/server/deep-analysis/repair";
import { runDeepGrantAnalysis } from "@/lib/server/deep-analysis/extractor";
import { sealDeepAnalysisInput } from "@/lib/server/deep-analysis/inputManifest";
import {
  decideDeepAnalysisValidationRoute,
  type DeepAnalysisValidationIssue,
  validateDeepAnalysisResult,
} from "@/lib/server/deep-analysis/validator";

const MAX_LAB_PRIMARY_REPAIRS = 2;
/** 패스당 issue 코드 기록 상한 — 폭주 방어. dedupe는 하지 않는다(반복 빈도가 진단 정보). */
const MAX_PASS_ISSUE_CODES = 20;
const MAX_PASS_ISSUE_DETAILS = 64;

export interface ValidatedLabPrimaryResult extends LabPrimaryRepairProvenance {
  extraction: DeepAnalysisModelResult;
  repairCount: number;
  deterministicPrimaryRepairCount: number;
  modelPrimaryRepairCount: number;
  newIssueAfterRepairCount: number;
  outcome: "publishable" | "held";
  /**
   * 패스별 validator 계측(2026-08-11 T4 1단계) — 어떤 issue 가 첫 패스를 떨어뜨리는지 진단용.
   * issueCodes 는 그 패스 결과의 validation 이슈 코드(빈 배열 = 그 패스로 통과).
   */
  passes: LabPrimaryPassDiagnostic[];
}

export class ValidatedLabPrimaryError extends Error implements LabPrimaryRepairProvenance {
  constructor(
    message: string,
    public readonly extraction: DeepAnalysisModelResult,
    public readonly repairCount: number,
    public readonly deterministicPrimaryRepairCount: number,
    public readonly modelPrimaryRepairCount: number,
    public readonly newIssueAfterRepairCount: number,
    public readonly passes: LabPrimaryPassDiagnostic[],
  ) {
    super(message);
    this.name = "ValidatedLabPrimaryError";
  }
}

/** 패스 직후 validator 진단을 bounded snapshot으로 남긴다. */
function collectPassDiagnostic(input: {
  kind: LabPrimaryPassDiagnostic["kind"];
  durationMs: number;
  issues: readonly DeepAnalysisValidationIssue[];
  result: DeepAnalysisModelResult;
}): LabPrimaryPassDiagnostic {
  return {
    kind: input.kind,
    durationMs: input.durationMs,
    issueCodes: input.issues.slice(0, MAX_PASS_ISSUE_CODES).map((issue) => issue.code),
    issueCount: input.issues.length,
    issues: input.issues.slice(0, MAX_PASS_ISSUE_DETAILS).map((issue) => (
      snapshotPassIssue(issue, input.result)
    )),
    issuesTruncated: input.issues.length > MAX_PASS_ISSUE_DETAILS,
  };
}

function snapshotPassIssue(
  issue: DeepAnalysisValidationIssue,
  result: DeepAnalysisModelResult,
): LabPrimaryPassIssue {
  const axisDimension = /^\$\.axis_assessments\.([a-z_]+)(?:\.|$)/.exec(issue.path)?.[1]
    ?? /^\$\.criteria\.([a-z_]+)(?:\.|$)/.exec(issue.path)?.[1];
  const axisIndex = /^\$\.axis_assessments\[(\d+)\]/.exec(issue.path)?.[1];
  const criterionIndex = /^\$\.criteria\[(\d+)\]/.exec(issue.path)?.[1];
  const axis = axisDimension
    ? result.axisAssessments.find((candidate) => candidate.dimension === axisDimension)
    : axisIndex !== undefined
      ? result.axisAssessments[Number.parseInt(axisIndex, 10)]
      : undefined;
  const criterion = criterionIndex !== undefined
    ? result.criteria[Number.parseInt(criterionIndex, 10)]
    : axisDimension
      ? result.criteria.find((candidate) => candidate.dimension === axisDimension)
      : undefined;
  return {
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(axis
      ? {
          axis: {
            dimension: axis.dimension,
            status: axis.status,
            comment: axis.comment,
          },
        }
      : {}),
    ...(criterion
      ? {
          criterion: {
            dimension: criterion.dimension,
            kind: criterion.kind,
            operator: criterion.operator,
            value: criterion.value,
            sourceSpan: criterion.sourceSpan,
            note: criterion.note,
          },
        }
      : {}),
  };
}

function countNewValidationIssues(
  before: readonly DeepAnalysisValidationIssue[],
  after: readonly DeepAnalysisValidationIssue[],
): number {
  // 메시지 문구 drift는 같은 issue로 보되, 같은 code+path의 중복 수가 늘면 새 유입으로 센다.
  const remainingBefore = new Map<string, number>();
  for (const issue of before) {
    const identity = `${issue.code}\u0000${issue.path}`;
    remainingBefore.set(identity, (remainingBefore.get(identity) ?? 0) + 1);
  }
  let newIssueCount = 0;
  for (const issue of after) {
    const identity = `${issue.code}\u0000${issue.path}`;
    const remaining = remainingBefore.get(identity) ?? 0;
    if (remaining === 0) newIssueCount += 1;
    else remainingBefore.set(identity, remaining - 1);
  }
  return newIssueCount;
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
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<ValidatedLabPrimaryResult> {
  input.signal?.throwIfAborted();
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
    ...(input.signal ? { signal: input.signal } : {}),
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
  passes.push(collectPassDiagnostic({
    kind: "primary",
    durationMs: firstDurationMs,
    issues: validation.issues,
    result: execution.result,
  }));
  let route = decideDeepAnalysisValidationRoute({ result: execution.result, validation });
  let repairCount = 0;
  let deterministicPrimaryRepairCount = 0;
  let modelPrimaryRepairCount = 0;
  let newIssueAfterRepairCount = 0;
  while (route.route === "repair" && repairCount < MAX_LAB_PRIMARY_REPAIRS) {
    input.signal?.throwIfAborted();
    // 결정적 교정만으로 끝나면 수 ms — 그 자체가 "모델 repair 없이 해결" 신호라 그대로 기록한다.
    const repairStartedAt = Date.now();
    const modelPassCountBeforeRepair = execution.passes.length;
    const validationIssuesBeforeRepair = validation.issues;
    execution = await repairDeepAnalysisExecution({
      seal,
      apiKey: input.apiKey,
      model: input.model,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      failedExecution: execution,
      validation,
      runModel,
    });
    const repairDurationMs = Date.now() - repairStartedAt;
    repairCount += 1;
    // 한 iteration은 model pass 증가 여부로 정확히 한 소유권에만 귀속한다.
    // 따라서 deterministicPrimaryRepairCount + modelPrimaryRepairCount === repairCount다.
    if (execution.passes.length > modelPassCountBeforeRepair) modelPrimaryRepairCount += 1;
    else deterministicPrimaryRepairCount += 1;
    validation = validateDeepAnalysisResult({ seal, result: execution.result });
    newIssueAfterRepairCount += countNewValidationIssues(
      validationIssuesBeforeRepair,
      validation.issues,
    );
    passes.push(collectPassDiagnostic({
      kind: "repair",
      durationMs: repairDurationMs,
      issues: validation.issues,
      result: execution.result,
    }));
    route = decideDeepAnalysisValidationRoute({ result: execution.result, validation });
  }
  if (route.route === "repair") {
    const issues = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join(", ");
    throw new ValidatedLabPrimaryError(
      `로컬 딥분석이 validator 교정 ${repairCount}회 뒤에도 실패했습니다: ${issues}`,
      execution.result,
      repairCount,
      deterministicPrimaryRepairCount,
      modelPrimaryRepairCount,
      newIssueAfterRepairCount,
      passes,
    );
  }
  return {
    extraction: execution.result,
    repairCount,
    deterministicPrimaryRepairCount,
    modelPrimaryRepairCount,
    newIssueAfterRepairCount,
    outcome: route.route === "accept" ? "publishable" : "held",
    passes,
  };
}
