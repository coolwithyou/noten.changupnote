import { createHash } from "node:crypto";
import {
  renderDeepAnalysisChunks,
  type DeepAnalysisModelPass,
} from "@/lib/server/deep-analysis/analyzer";
import type { DeepAnalysisEffort, DeepAnalysisModelResult } from "@cunote/contracts";
import type {
  LabPrimaryPassDiagnostic,
  LabPrimaryPassIssue,
  LabPrimaryRepairProvenance,
} from "@/lib/server/analysis-lab/lab-contract";
import { repairDeepAnalysisExecution } from "@/lib/server/deep-analysis/repair";
import { runDeepGrantAnalysis } from "@/lib/server/deep-analysis/extractor";
import { sealDeepAnalysisInput } from "@/lib/server/deep-analysis/inputManifest";
import { stableJson } from "@/lib/server/deep-analysis/sourceRevision";
import {
  decideDeepAnalysisValidationRoute,
  type DeepAnalysisValidationRoute,
  type DeepAnalysisValidationIssue,
  type DeepAnalysisValidationResult,
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
  blockingNewIssueAfterRepairCount: number;
  sourceIncompleteIssueAfterRepairCount: number;
  outcome: "publishable" | "held";
  matchingReadiness: "ready" | "conditional" | "deferred";
  terminationReason: "accepted" | "held";
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
    public readonly blockingNewIssueAfterRepairCount: number,
    public readonly sourceIncompleteIssueAfterRepairCount: number,
    public readonly passes: LabPrimaryPassDiagnostic[],
    public readonly terminationReason:
      | "repair_limit"
      | "exact_no_progress"
      | "semantic_no_progress",
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
    semanticFingerprintSha256: createHash("sha256").update(validationRepairStateSignature({
      result: input.result,
      issues: input.issues,
    })).digest("hex"),
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

interface ValidationIssueTransitionCounts {
  readonly total: number;
  readonly blocking: number;
  readonly sourceIncomplete: number;
}

function validationIssueDimension(
  issue: DeepAnalysisValidationIssue,
  result: DeepAnalysisModelResult,
): string | null {
  const direct = /^\$\.axis_assessments\.([a-z_]+)(?:\.|$)/.exec(issue.path)?.[1]
    ?? /^\$\.criteria\.([a-z_]+)(?:\.|$)/.exec(issue.path)?.[1];
  if (direct) return direct;
  const axisIndex = /^\$\.axis_assessments\[(\d+)\]/.exec(issue.path)?.[1];
  if (axisIndex !== undefined) {
    return result.axisAssessments[Number.parseInt(axisIndex, 10)]?.dimension ?? null;
  }
  const criterionIndex = /^\$\.criteria\[(\d+)\]/.exec(issue.path)?.[1];
  if (criterionIndex !== undefined) {
    return result.criteria[Number.parseInt(criterionIndex, 10)]?.dimension ?? null;
  }
  return null;
}

function countValidationIssueTransitions(input: {
  beforeIssues: readonly DeepAnalysisValidationIssue[];
  beforeResult: DeepAnalysisModelResult;
  afterIssues: readonly DeepAnalysisValidationIssue[];
  afterResult: DeepAnalysisModelResult;
}): ValidationIssueTransitionCounts {
  // 메시지 문구 drift는 같은 issue로 보되, 같은 code+path의 중복 수가 늘면 새 유입으로 센다.
  const remainingBefore = new Map<string, DeepAnalysisValidationIssue[]>();
  for (const issue of input.beforeIssues) {
    const identity = `${issue.code}\u0000${issue.path}`;
    const matches = remainingBefore.get(identity) ?? [];
    matches.push(issue);
    remainingBefore.set(identity, matches);
  }
  const newAfter: DeepAnalysisValidationIssue[] = [];
  for (const issue of input.afterIssues) {
    const identity = `${issue.code}\u0000${issue.path}`;
    const matches = remainingBefore.get(identity);
    if (!matches || matches.length === 0) newAfter.push(issue);
    else matches.pop();
  }
  const removedBefore = [...remainingBefore.values()].flat();
  const removedDimensions = new Map<string, number>();
  for (const issue of removedBefore) {
    const dimension = validationIssueDimension(issue, input.beforeResult);
    if (dimension) removedDimensions.set(dimension, (removedDimensions.get(dimension) ?? 0) + 1);
  }

  let sourceIncomplete = 0;
  for (const issue of newAfter) {
    if (issue.code !== "unresolved_axis") continue;
    const dimension = validationIssueDimension(issue, input.afterResult);
    if (!dimension || (removedDimensions.get(dimension) ?? 0) === 0) continue;
    const axis = input.afterResult.axisAssessments.find((candidate) => candidate.dimension === dimension);
    if (axis?.status !== "input_missing") continue;
    sourceIncomplete += 1;
    removedDimensions.set(dimension, (removedDimensions.get(dimension) ?? 0) - 1);
  }
  return {
    total: newAfter.length,
    blocking: newAfter.length - sourceIncomplete,
    sourceIncomplete,
  };
}

/** 실행 비용·원문 응답 메타를 제외한 validator 입력과 오류가 완전히 같은지 비교한다. */
function validationRepairStateSignature(input: {
  result: DeepAnalysisModelResult;
  issues: readonly DeepAnalysisValidationIssue[];
}): string {
  const validatorRelevantResult = {
    model: input.result.model,
    effort: input.result.effort,
    analysisMarkdown: input.result.analysisMarkdown,
    programIntent: input.result.programIntent,
    criteria: input.result.criteria,
    axisAssessments: input.result.axisAssessments,
    taxonomyProposals: input.result.taxonomyProposals,
    sourceLimitations: input.result.sourceLimitations ?? [],
    stopReason: input.result.stopReason,
  };
  const issues = input.issues
    .map((issue) => ({ code: issue.code, path: issue.path, message: issue.message }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return stableJson({ result: validatorRelevantResult, issues });
}

/**
 * 현재는 target_type list_semantics 모순 한 종류만 의미 비교한다. 지원하지 않는 issue가
 * 하나라도 섞이면 null을 반환해 기존 전체-result 비교와 repair 상한을 그대로 사용한다.
 */
function comparableListSemanticsIssueState(input: {
  result: DeepAnalysisModelResult;
  validation: DeepAnalysisValidationResult;
}): string | null {
  if (input.validation.issues.length === 0) return null;
  const states: Array<Record<string, unknown>> = [];
  for (const issue of input.validation.issues) {
    if (issue.code !== "semantic_misattribution") return null;
    const match = /^\$\.criteria\[(\d+)\]\.value\.list_semantics$/.exec(issue.path);
    if (!match) return null;
    const criterionIndex = Number.parseInt(match[1]!, 10);
    const criterion = input.result.criteria[criterionIndex];
    if (
      !criterion
      || criterion.dimension !== "target_type"
      || criterion.operator !== "in"
      || !isRecord(criterion.value)
    ) return null;
    const value = { ...criterion.value };
    const valueNote = typeof value.note === "string" ? value.note : null;
    delete value.note;
    const evidenceRefs = input.validation.criteria
      .find((validated) => validated.index === criterionIndex)
      ?.evidenceRefs
      .map((reference) => ({ ...reference }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right))) ?? [];
    states.push({
      code: issue.code,
      path: issue.path,
      dimension: criterion.dimension,
      kind: criterion.kind,
      operator: criterion.operator,
      value,
      sourceSpan: criterion.sourceSpan,
      spanVerified: criterion.spanVerified,
      evidenceRefs,
      noteClaims: listSemanticsNoteClaims([criterion.note, valueNote]),
    });
  }
  return stableJson(states.sort((left, right) => (
    stableJson(left).localeCompare(stableJson(right))
  )));
}

function listSemanticsNoteClaims(notes: Array<string | null>): {
  requiresOpen: boolean;
  requiresClosed: boolean;
  materialQualifiers: string[];
} {
  const normalized = notes
    .filter((note): note is string => Boolean(note?.trim()))
    .map((note) => note.normalize("NFKC").replace(/\s+/gu, " ").trim());
  const joined = normalized.join(" ");
  const materialQualifiers = normalized
    .flatMap((note) => note.split(/(?<=[.!?。])\s+/u))
    .filter((sentence) => (
      /(?:단|다만|예외|추가\s*(?:자격|요건)|별도\s*(?:자격|요건)|적용\s*대상)/u.test(sentence)
    ))
    .sort();
  return {
    requiresOpen: /list_semantics\s*=\s*open/iu.test(joined)
      || /(?:열린|개방형|완전\s*열거가\s*아닌|예시적).{0,24}(?:목록|열거)/iu.test(joined)
      || /목록\s*밖.{0,40}(?:자동\s*)?탈락시키지/iu.test(joined),
    requiresClosed: /list_semantics\s*=\s*closed/iu.test(joined)
      || /(?:폐쇄|닫힌|완전한|배타적).{0,24}(?:목록|열거)/iu.test(joined)
      || /목록\s*밖.{0,40}(?:신청\s*불가|탈락)/iu.test(joined),
    materialQualifiers,
  };
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
  // lab의 조립 입력은 실제 archive provenance를 다시 구성하지 않는다. 전체 current blob을
  // synthetic structured chunk로만 봉인하고 그 exact id/SHA catalog를 모델에 노출한다.
  const modelInputText = renderDeepAnalysisChunks(seal.chunks);
  const runModel = input.runModel ?? ((options) => runDeepGrantAnalysis({
    ...options,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  }));
  const passes: ValidatedLabPrimaryResult["passes"] = [];
  const firstStartedAt = Date.now();
  const first = await runModel({
    apiKey: input.apiKey,
    inputText: modelInputText,
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
    inputChars: modelInputText.length,
    result: first,
  };
  let execution = {
    result: first,
    passes: [firstPass],
    evidenceText: modelInputText,
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
  let blockingNewIssueAfterRepairCount = 0;
  let sourceIncompleteIssueAfterRepairCount = 0;
  let noProgressReason: "exact_no_progress" | "semantic_no_progress" | null = null;
  while (route.route === "repair" && repairCount < MAX_LAB_PRIMARY_REPAIRS) {
    input.signal?.throwIfAborted();
    // 결정적 교정만으로 끝나면 수 ms — 그 자체가 "모델 repair 없이 해결" 신호라 그대로 기록한다.
    const repairStartedAt = Date.now();
    const modelPassCountBeforeRepair = execution.passes.length;
    const validationIssuesBeforeRepair = validation.issues;
    const resultBeforeRepair = execution.result;
    const stateBeforeRepair = validationRepairStateSignature({
      result: resultBeforeRepair,
      issues: validationIssuesBeforeRepair,
    });
    const semanticStateBeforeRepair = comparableListSemanticsIssueState({
      result: resultBeforeRepair,
      validation,
    });
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
    const transition = countValidationIssueTransitions({
      beforeIssues: validationIssuesBeforeRepair,
      beforeResult: resultBeforeRepair,
      afterIssues: validation.issues,
      afterResult: execution.result,
    });
    newIssueAfterRepairCount += transition.total;
    blockingNewIssueAfterRepairCount += transition.blocking;
    sourceIncompleteIssueAfterRepairCount += transition.sourceIncomplete;
    passes.push(collectPassDiagnostic({
      kind: "repair",
      durationMs: repairDurationMs,
      issues: validation.issues,
      result: execution.result,
    }));
    route = decideDeepAnalysisValidationRoute({ result: execution.result, validation });
    if (route.route === "repair") {
      const stateAfterRepair = validationRepairStateSignature({
        result: execution.result,
        issues: validation.issues,
      });
      const semanticStateAfterRepair = comparableListSemanticsIssueState({
        result: execution.result,
        validation,
      });
      if (stateAfterRepair === stateBeforeRepair) {
        noProgressReason = "exact_no_progress";
        break;
      }
      if (
        semanticStateBeforeRepair !== null
        && semanticStateAfterRepair === semanticStateBeforeRepair
      ) {
        noProgressReason = "semantic_no_progress";
        break;
      }
    }
  }
  if (route.route === "repair") {
    const issues = validation.issues
      .slice(0, 8)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join(", ");
    throw new ValidatedLabPrimaryError(
      `로컬 딥분석이 validator 교정 ${repairCount}회 뒤에도 실패했습니다` +
        ` (종료=${noProgressReason ?? "repair_limit"}): ${issues}`,
      execution.result,
      repairCount,
      deterministicPrimaryRepairCount,
      modelPrimaryRepairCount,
      newIssueAfterRepairCount,
      blockingNewIssueAfterRepairCount,
      sourceIncompleteIssueAfterRepairCount,
      passes,
      noProgressReason ?? "repair_limit",
    );
  }
  const matchingReadiness = classifyMatchingReadiness(execution.result, route);
  return {
    extraction: execution.result,
    repairCount,
    deterministicPrimaryRepairCount,
    modelPrimaryRepairCount,
    newIssueAfterRepairCount,
    blockingNewIssueAfterRepairCount,
    sourceIncompleteIssueAfterRepairCount,
    outcome: matchingReadiness === "deferred" ? "held" : "publishable",
    matchingReadiness,
    terminationReason: matchingReadiness === "deferred" ? "held" : "accepted",
    passes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyMatchingReadiness(
  result: DeepAnalysisModelResult,
  route: Exclude<DeepAnalysisValidationRoute, { route: "repair" }>,
): ValidatedLabPrimaryResult["matchingReadiness"] {
  if (route.route === "accept") return "ready";
  if (route.holdIssues.some((issue) => (
    issue.code !== "unresolved_axis" && issue.code !== "source_incomplete"
  ))) return "deferred";

  // 한 축만 확인된 공고는 포털의 거친 대상 라벨 수준이라 실제 랭킹 근거로 부족하다.
  // 두 축 이상을 확인했다면 확인된 조건으로 후보를 만들고, unresolved 축은 대표자 질문으로 남긴다.
  const resolvedAxisCount = result.axisAssessments.filter(
    (axis) => axis.status === "condition_found" || axis.status === "inspected_no_condition",
  ).length;
  return resolvedAxisCount >= 2 ? "conditional" : "deferred";
}
