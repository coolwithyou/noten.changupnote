import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { runValidatedLabPrimary } from "./validated-primary";

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
const repaired = await runValidatedLabPrimary({
  grantId: "grant-lab-repair",
  inputText,
  inputSha256: "a".repeat(64),
  apiKey: "subscription",
  model: "claude-opus-5",
  runModel: async (options) => {
    calls += 1;
    if (calls > 1) assert.match(options.taskInstruction ?? "", /validator 실패 사유/);
    return result(calls > 1);
  },
});
assert.equal(calls, 2, "정규화 누락을 1회 교정");
assert.equal(repaired.repairCount, 1);
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
assert.equal(clean.passes.length, 1, "무repair 성공은 primary 패스 1개만 계측");
assert.equal(clean.passes[0]?.kind, "primary");
assert.deepEqual(clean.passes[0]?.issueCodes, [], "통과 패스는 issueCodes 빈 배열");
assert.ok((clean.passes[0]?.durationMs ?? -1) >= 0, "패스 durationMs 는 0 이상");

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

let failedCalls = 0;
await assert.rejects(
  runValidatedLabPrimary({
    grantId: "grant-lab-repair-failed",
    inputText,
    inputSha256: "b".repeat(64),
    apiKey: "subscription",
    model: "claude-opus-5",
    runModel: async () => {
      failedCalls += 1;
      return result(false);
    },
  }),
  /validator 교정 2회 뒤에도 실패.*normalization_drop.*axis_criterion_mismatch/,
);
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
