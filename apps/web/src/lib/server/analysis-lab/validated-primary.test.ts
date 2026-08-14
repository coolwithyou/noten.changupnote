import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import {
  runValidatedLabPrimary,
  ValidatedLabPrimaryError,
} from "./validated-primary";

const contractRepairProvenance = {
  deterministicPrimaryRepairCount: 1,
  modelPrimaryRepairCount: 2,
  newIssueAfterRepairCount: 3,
} satisfies NonNullable<LabRun["primaryRepairProvenance"]>;
assert.deepEqual(contractRepairProvenance, {
  deterministicPrimaryRepairCount: 1,
  modelPrimaryRepairCount: 2,
  newIssueAfterRepairCount: 3,
});

const inputText = [
  "공고",
  "서울 소재 중소기업만 신청할 수 있다.",
  "서울 사업장에 입주한 지 3년 이상인 기업을 우대한다.",
].join("\n");
const sourceSpan = "서울 소재 중소기업만 신청할 수 있다.";
const validCriterion: DeepAnalysisCriterion = {
  dimension: "region",
  kind: "required",
  operator: "in",
  value: { regions: ["11"] },
  confidence: 0.95,
  sourceSpan,
  spanVerified: true,
  note: null,
};

const axes = (found: boolean): DeepAnalysisAxisAssessment[] => CRITERION_DIMENSIONS.map((dimension) => ({
  dimension,
  status: dimension === "region" && found ? "condition_found" : "inspected_no_condition",
  confidence: 0.9,
  comment: "전문 검사",
}));

const result = (valid: boolean): DeepAnalysisModelResult => {
  const criteria = valid ? [validCriterion] : [];
  const assessments = axes(true);
  return {
    model: "claude-opus-5",
    analysisMarkdown: "# 분석",
    programIntent: null,
    criteria,
    axisAssessments: assessments,
    taxonomyProposals: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null },
    costUsd: 0.1,
    rawToolInput: {
      criteria: [rawCriterion(validCriterion)],
      axis_assessments: assessments.map((axis) => ({
        dimension: axis.dimension,
        status: axis.status,
        confidence: axis.confidence,
        comment: axis.comment,
      })),
    },
    rawResponseText: "{}",
    stopReason: "tool_use",
  };
};

let calls = 0;
const repairSignal = new AbortController().signal;
const repaired = await runValidatedLabPrimary({
  grantId: "grant-lab-repair",
  inputText,
  inputSha256: "a".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  signal: repairSignal,
  runModel: async (options) => {
    calls += 1;
    assert.equal(
      options.signal,
      repairSignal,
      "동일 lease signal이 initial과 모든 model repair에 관통해야 한다",
    );
    if (calls > 1) assert.match(options.taskInstruction ?? "", /validator 실패 사유/);
    return result(calls > 1);
  },
});
assert.equal(calls, 2, "정규화 누락을 1회 교정");
assert.equal(repaired.repairCount, 1);
assert.equal(repaired.deterministicPrimaryRepairCount, 0);
assert.equal(repaired.modelPrimaryRepairCount, 1);
assert.equal(repaired.newIssueAfterRepairCount, 0);
assert.equal(repaired.extraction.criteria.length, 1);
assert.equal(repaired.extraction.usage?.inputTokens, 20, "교정 호출 usage 합산");
assert.equal(repaired.extraction.costUsd, 0.2, "교정 호출 명목 비용 합산");
// T4 패스별 계측 — repair 1회 성공은 primary+repair 패스 2개를 남긴다.
assert.equal(repaired.passes.length, 2, "패스별 계측 2건(primary+repair)");
assert.equal(repaired.passes[0]?.kind, "primary");
assert.ok(
  repaired.passes[0]?.issueCodes.includes("normalization_drop"),
  "첫 패스 issueCodes 에 실패 코드 기록",
);
assert.equal(repaired.passes[1]?.kind, "repair");
assert.deepEqual(repaired.passes[1]?.issueCodes, [], "둘째 패스로 통과(빈 배열)");
assert.ok((repaired.passes[0]?.durationMs ?? -1) >= 0, "패스 durationMs 는 0 이상");

// 무repair 성공 — primary 패스 1개, issueCodes 빈 배열.
let cleanCalls = 0;
const clean = await runValidatedLabPrimary({
  grantId: "grant-lab-clean",
  inputText,
  inputSha256: "c".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    cleanCalls += 1;
    return result(true);
  },
});
assert.equal(cleanCalls, 1, "무repair 성공은 모델 호출 1회");
assert.equal(clean.repairCount, 0);
assert.equal(clean.deterministicPrimaryRepairCount, 0);
assert.equal(clean.modelPrimaryRepairCount, 0);
assert.equal(clean.newIssueAfterRepairCount, 0);
assert.equal(clean.matchingReadiness, "ready");
assert.equal(clean.passes.length, 1, "무repair 성공은 primary 패스 1개만 계측");
assert.equal(clean.passes[0]?.kind, "primary");
assert.deepEqual(clean.passes[0]?.issueCodes, [], "통과 패스는 issueCodes 빈 배열");
assert.ok((clean.passes[0]?.durationMs ?? -1) >= 0, "패스 durationMs 는 0 이상");

// model pass가 늘지 않은 repair iteration은 결정적 primary repair로 계수한다.
let deterministicCalls = 0;
const deterministicallyRepaired = await runValidatedLabPrimary({
  grantId: "grant-lab-deterministic-repair",
  inputText,
  inputSha256: "2".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    deterministicCalls += 1;
    if (deterministicCalls > 1) throw new Error("결정적 교정은 모델을 다시 호출하면 안 됨");
    return deterministicAxisMismatchResult();
  },
});
assert.equal(deterministicCalls, 1);
assert.equal(deterministicallyRepaired.repairCount, 1);
assert.equal(deterministicallyRepaired.deterministicPrimaryRepairCount, 1);
assert.equal(deterministicallyRepaired.modelPrimaryRepairCount, 0);
assert.equal(deterministicallyRepaired.newIssueAfterRepairCount, 0);

// issueCodes 20개 상한과 별개로 전체 issue 수와 경로별 축 snapshot을 보존한다.
let unresolvedCalls = 0;
const diagnosedUnresolved = await runValidatedLabPrimary({
  grantId: "grant-lab-unresolved-diagnostics",
  inputText,
  inputSha256: "d".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    unresolvedCalls += 1;
    return unresolvedCalls === 1 ? unresolvedResult() : result(true);
  },
});
const unresolvedPass = diagnosedUnresolved.passes[0];
assert.equal(unresolvedCalls, 1, "unresolved-only는 LLM repair를 호출하지 않음");
assert.equal(diagnosedUnresolved.outcome, "held");
assert.equal(diagnosedUnresolved.matchingReadiness, "deferred");
assert.equal(diagnosedUnresolved.repairCount, 0);
assert.equal(unresolvedPass?.issueCodes.length, 20, "기존 issueCodes 폭주 상한은 유지");
assert.equal(unresolvedPass?.issueCount, 22, "상한과 무관한 전체 issue 수 보존");
assert.equal(unresolvedPass?.issues?.length, 22, "22축 unresolved detail 전부 보존");
assert.equal(unresolvedPass?.issuesTruncated, false);
assert.deepEqual(unresolvedPass?.issues?.[0]?.axis, {
  dimension: CRITERION_DIMENSIONS[0],
  status: "ambiguous",
  comment: "근거 충돌",
});
assert.match(unresolvedPass?.issues?.[0]?.path ?? "", /^\$\.axis_assessments\./);

let missingInputCalls = 0;
const conditionalMissingInput = await runValidatedLabPrimary({
  grantId: "grant-lab-input-missing",
  inputText,
  inputSha256: "1".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    missingInputCalls += 1;
    return inputMissingResult();
  },
});
assert.equal(missingInputCalls, 1, "실제 input_missing도 전체 재생성을 호출하지 않음");
assert.equal(conditionalMissingInput.outcome, "publishable");
assert.equal(conditionalMissingInput.matchingReadiness, "conditional");
assert.equal(conditionalMissingInput.repairCount, 0);
assert.deepEqual(
  conditionalMissingInput.passes[0]?.issues?.map((issue) => issue.code),
  ["unresolved_axis"],
);
assert.equal(conditionalMissingInput.passes[0]?.issues?.[0]?.axis?.status, "input_missing");

const sourceInsufficient = await runValidatedLabPrimary({
  grantId: "grant-lab-source-insufficient",
  inputText,
  inputSha256: "3".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => mostlyMissingInputResult(),
});
assert.equal(sourceInsufficient.outcome, "held");
assert.equal(sourceInsufficient.matchingReadiness, "deferred");

const unresolvedWithCriterion = await runValidatedLabPrimary({
  grantId: "grant-lab-unresolved-with-criterion",
  inputText,
  inputSha256: "4".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => ambiguousCriterionResult(),
});
assert.equal(unresolvedWithCriterion.outcome, "held");
assert.equal(unresolvedWithCriterion.matchingReadiness, "deferred");

// criterion 단위 semantic issue는 문제 criterion snapshot을 함께 남긴다.
let semanticCalls = 0;
const diagnosedSemantic = await runValidatedLabPrimary({
  grantId: "grant-lab-semantic-diagnostics",
  inputText,
  inputSha256: "e".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    semanticCalls += 1;
    return semanticCalls === 1 ? semanticInvalidResult() : result(true);
  },
});
const semanticIssue = diagnosedSemantic.passes[0]?.issues?.find(
  (issue) => issue.code === "semantic_misattribution",
);
assert.equal(semanticIssue?.criterion?.dimension, "biz_age");
assert.equal(semanticIssue?.criterion?.operator, "gte");
assert.equal(
  semanticIssue?.criterion?.sourceSpan,
  "서울 사업장에 입주한 지 3년 이상인 기업을 우대한다.",
);

// repair 전에는 없던 code+path issue가 다음 validation에 나타나면 새 유입으로 계수한다.
let transitionCalls = 0;
const repairedWithNewIssue = await runValidatedLabPrimary({
  grantId: "grant-lab-new-issue-transition",
  inputText,
  inputSha256: "3".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async () => {
    transitionCalls += 1;
    if (transitionCalls === 1) return result(false);
    if (transitionCalls === 2) return semanticInvalidResult();
    return result(true);
  },
});
assert.equal(transitionCalls, 3);
assert.equal(repairedWithNewIssue.repairCount, 2);
assert.equal(repairedWithNewIssue.deterministicPrimaryRepairCount, 0);
assert.equal(repairedWithNewIssue.modelPrimaryRepairCount, 2);
assert.equal(repairedWithNewIssue.newIssueAfterRepairCount, 1);

let mixedCalls = 0;
const repairedMixed = await runValidatedLabPrimary({
  grantId: "grant-lab-mixed-route",
  inputText,
  inputSha256: "f".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async (options) => {
    mixedCalls += 1;
    if (mixedCalls > 1) {
      assert.match(options.inputText, /normalization_drop/);
      assert.doesNotMatch(
        options.inputText,
        /unresolved_axis/,
        "mixed repair prompt는 보류 issue를 모델 교정 대상으로 되먹이지 않음",
      );
    }
    return mixedCalls === 1 ? mixedUnresolvedResult() : result(true);
  },
});
assert.equal(mixedCalls, 2, "unresolved와 실제 계약 오류가 섞이면 repair");
assert.equal(repairedMixed.outcome, "publishable");

let failedCalls = 0;
let failedError: unknown;
try {
  await runValidatedLabPrimary({
    grantId: "grant-lab-repair-failed",
    inputText,
    inputSha256: "b".repeat(64),
    apiKey: "subscription",
    model: "claude-opus-5",
    runModel: async () => {
      failedCalls += 1;
      return result(false);
    },
  });
} catch (error) {
  failedError = error;
}
assert.ok(failedError instanceof ValidatedLabPrimaryError);
assert.match(
  failedError.message,
  /validator 교정 2회 뒤에도 실패.*normalization_drop.*axis_criterion_mismatch/,
);
assert.equal(failedError.repairCount, 2);
assert.equal(failedError.deterministicPrimaryRepairCount, 0);
assert.equal(failedError.modelPrimaryRepairCount, 2);
assert.equal(failedError.newIssueAfterRepairCount, 0);
assert.equal(failedError.passes.length, 3, "실패해도 primary+repair 진단 전부 운반");
assert.equal(failedError.extraction.criteria.length, 0, "마지막 실패 extraction 보존");
assert.equal(failedCalls, 3, "최초 1회와 교정 최대 2회 뒤 실패");

console.log("analysis-lab validated primary tests: ok");

function rawCriterion(criterion: DeepAnalysisCriterion): Record<string, unknown> {
  return {
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
    confidence: criterion.confidence,
    source_span: criterion.sourceSpan,
  };
}

function unresolvedResult(): DeepAnalysisModelResult {
  const assessments: DeepAnalysisAxisAssessment[] = CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: "ambiguous",
    confidence: 0.5,
    comment: "근거 충돌",
  }));
  return {
    ...result(true),
    criteria: [],
    axisAssessments: assessments,
    rawToolInput: {
      criteria: [],
      axis_assessments: assessments.map((axis) => ({ ...axis })),
    },
  };
}

function semanticInvalidResult(): DeepAnalysisModelResult {
  const invalidCriterion: DeepAnalysisCriterion = {
    dimension: "biz_age",
    kind: "preferred",
    operator: "gte",
    value: { min_months: 36 },
    confidence: 0.9,
    sourceSpan: "서울 사업장에 입주한 지 3년 이상인 기업을 우대한다.",
    spanVerified: true,
    note: null,
  };
  const assessments = axes(false).map((axis) => axis.dimension === "biz_age"
    ? { ...axis, status: "condition_found" as const }
    : axis);
  return {
    ...result(true),
    criteria: [invalidCriterion],
    axisAssessments: assessments,
    rawToolInput: {
      criteria: [rawCriterion(invalidCriterion)],
      axis_assessments: assessments.map((axis) => ({ ...axis })),
    },
  };
}

function inputMissingResult(): DeepAnalysisModelResult {
  const assessments = axes(false).map((axis) => axis.dimension === "industry"
    ? {
      ...axis,
      status: "input_missing" as const,
      comment: "공고가 가리키는 상세 업종 첨부가 입력에 없음",
    }
    : axis);
  return {
    ...result(true),
    criteria: [],
    axisAssessments: assessments,
    rawToolInput: {
      criteria: [],
      axis_assessments: assessments.map((axis) => ({ ...axis })),
    },
  };
}

function mostlyMissingInputResult(): DeepAnalysisModelResult {
  const assessments = CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: dimension === "size" ? "condition_found" as const : "input_missing" as const,
    confidence: 0.5,
    comment: dimension === "size" ? "소상공인" : "상세 공고문이 입력에 없음",
  }));
  const sizeCriterion: DeepAnalysisCriterion = {
    dimension: "size",
    kind: "required",
    operator: "in",
    value: { sizes: ["소상공인"] },
    confidence: 0.9,
    sourceSpan: "서울 소재 중소기업만 신청할 수 있다.",
    spanVerified: true,
    note: null,
  };
  return {
    ...result(true),
    criteria: [sizeCriterion],
    axisAssessments: assessments,
    rawToolInput: {
      criteria: [rawCriterion(sizeCriterion)],
      axis_assessments: assessments.map((axis) => ({ ...axis })),
    },
  };
}

function ambiguousCriterionResult(): DeepAnalysisModelResult {
  const assessments = axes(true).map((axis) => axis.dimension === "region"
    ? { ...axis, status: "ambiguous" as const, comment: "지역 문구가 충돌함" }
    : axis);
  return {
    ...result(true),
    criteria: [validCriterion],
    axisAssessments: assessments,
    rawToolInput: {
      criteria: [rawCriterion(validCriterion)],
      axis_assessments: assessments.map((axis) => ({ ...axis })),
    },
  };
}

function deterministicAxisMismatchResult(): DeepAnalysisModelResult {
  const mismatchedAxes = axes(false);
  return {
    ...result(true),
    axisAssessments: mismatchedAxes,
    rawToolInput: {
      criteria: [rawCriterion(validCriterion)],
      axis_assessments: mismatchedAxes.map((axis) => ({ ...axis })),
    },
  };
}

function mixedUnresolvedResult(): DeepAnalysisModelResult {
  const mixed = unresolvedResult();
  (mixed.rawToolInput.criteria as Array<Record<string, unknown>>).push({
    dimension: "region",
    kind: "required",
    operator: "unknown_operator",
    value: {},
    confidence: 0.5,
    source_span: sourceSpan,
  });
  return mixed;
}
