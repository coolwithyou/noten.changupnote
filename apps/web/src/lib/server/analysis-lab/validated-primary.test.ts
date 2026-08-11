import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { runValidatedLabPrimary } from "./validated-primary";

const inputText = "공고\n서울 소재 중소기업만 신청할 수 있다.";
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

