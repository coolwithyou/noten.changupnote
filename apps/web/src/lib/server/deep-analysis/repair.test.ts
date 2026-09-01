import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { renderDeepAnalysisChunks, type DeepAnalysisExecution } from "./analyzer";
import { findExactEvidenceSpanCandidates } from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  DEEP_ANALYSIS_VALIDATOR_VERSION,
  validateDeepAnalysisResult,
} from "./validator";
import {
  buildDeepAnalysisAuditRetryFeedback,
  buildDeepAnalysisEvidenceRepairHints,
  DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION,
  DEEP_ANALYSIS_REPAIR_VERSION,
  repairDeepAnalysisAxisStatusesDeterministically,
  repairDeepAnalysisEvidenceSpansDeterministically,
  repairDeepAnalysisMatchingScopeDeterministically,
  repairDeepAnalysisExecution,
} from "./repair";

const requestedSpan = "사업영위 기간 10년 이상 5";
const exactSpanA = "사업영위 기간 10년 이상    5";
const exactSpanB = "사업영위 기간 10년 이상\t5";
const seal = sealDeepAnalysisInput({
  grantId: "repair-grant",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: `${exactSpanA}\n${exactSpanB}`,
  attachments: [],
});
const result: DeepAnalysisModelResult = {
  model: "claude-opus-4-8",
  analysisMarkdown: "",
  programIntent: null,
  criteria: [{
    dimension: "biz_age",
    kind: "preferred",
    operator: "gte",
    value: { min_months: 120 },
    confidence: 0.7,
    sourceSpan: requestedSpan,
    spanVerified: false,
    spanOffsetRatio: null,
    note: null,
  }],
  axisAssessments: [],
  taxonomyProposals: [],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null },
  costUsd: 0.1,
  rawToolInput: {},
  rawResponseText: "{}",
  stopReason: "tool_use",
};
const execution: DeepAnalysisExecution = {
  evidenceText: renderDeepAnalysisChunks(seal.chunks),
  result,
  passes: [{ kind: "single", chunkId: null, inputChars: 10, result }],
};
const validation = {
  validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
  valid: false,
  responseContractValid: true,
  axisCoverageComplete: false,
  evidenceGrounded: false,
  issues: [
    {
      code: "evidence_not_grounded" as const,
      path: "$.criteria[0].source_span",
      message: "source_span does not exactly map to a sealed chunk",
    },
    {
      code: "axis_criterion_mismatch" as const,
      path: "$.axis_assessments.founder_trait",
      message: "condition_found requires at least one criterion",
    },
  ],
  criteria: [],
  axisCriterionSemanticHashes: Object.fromEntries(
    [
      "region", "biz_age", "industry", "size", "revenue", "employees",
      "founder_age", "founder_trait", "certification", "prior_award", "ip",
      "target_type", "business_status", "tax_compliance", "credit_status",
      "sanction", "financial_health", "insured_workforce", "investment",
      "premises", "export_performance", "other",
    ].map((dimension) => [dimension, []]),
  ) as never,
};
assert.equal(DEEP_ANALYSIS_REPAIR_VERSION, "deep-analysis-repair-v6");
assert.equal(
  findExactEvidenceSpanCandidates(requestedSpan, execution.evidenceText).length,
  2,
);
assert.deepEqual(
  findExactEvidenceSpanCandidates(
    "사업영위 기간 10년 이상 5",
    "Ⅶ. 사업영위 기간\n(5점)\n10년 이상\n5",
  ),
  ["사업영위 기간\n(5점)\n10년 이상\n5"],
);
assert.deepEqual(
  buildDeepAnalysisEvidenceRepairHints({ execution, validation }),
  [{
    issuePath: "$.criteria[0].source_span",
    criterionIndex: 0,
    requestedSourceSpan: requestedSpan,
    exactCandidates: [exactSpanA, exactSpanB],
    candidateCount: 2,
    truncated: false,
  }],
);
assert.deepEqual(
  repairDeepAnalysisEvidenceSpansDeterministically({ execution, validation }),
  { execution, repairs: [] },
);
let repairInstruction = "";
let repairInput = "";
const repaired = await repairDeepAnalysisExecution({
  seal,
  apiKey: "test",
  model: "claude-opus-4-8",
  failedExecution: execution,
  validation,
  runModel: async (options) => {
    repairInstruction = options.taskInstruction ?? "";
    repairInput = options.inputText;
    return {
      ...result,
      usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 2 },
      costUsd: 0.2,
    };
  },
});
assert.equal(repaired.passes.length, 2);
assert.equal(repaired.passes[1]?.kind, "repair");
assert.equal(repaired.result.usage?.inputTokens, 30);
assert.equal(repaired.result.usage?.outputTokens, 13);
assert.equal(repaired.result.usage?.cacheReadTokens, 2);
assert.ok(Math.abs((repaired.result.costUsd ?? 0) - 0.3) < 1e-9);
assert.match(repairInstruction, /validator 실패/);
assert.match(repairInstruction, /exactCandidates/);
assert.match(repairInstruction, /axis_criterion_mismatch/);
assert.match(repairInstruction, /source_field: aply_trgt/);
assert.match(repairInstruction, /biz_enyy/);
assert.match(repairInstruction, /서로 다른 22축이 섞인 대안/);
const failedResultBlock =
  /<<<FAILED_RESULT_TO_REPAIR>>>\n([\s\S]+)\n<<<END_FAILED_RESULT_TO_REPAIR>>>/
    .exec(repairInput)?.[1];
assert.ok(failedResultBlock);
assert.deepEqual(
  (JSON.parse(failedResultBlock) as {
    evidenceRepairHints: unknown[];
  }).evidenceRepairHints,
  buildDeepAnalysisEvidenceRepairHints({ execution, validation }),
);

const scoreTableExactSpan =
  "2. 참가 계획                                   20\n" +
  "(70 점)                   기대효과 등";
const scoreTableRequestedSpan =
  "2. 참가 계획                                   20\n" +
  "                         기대효과 등";
const scoreCandidateDecoys = Array.from({ length: 20 }, (_, index) => (
  `2 참가 ${"무관한문구 ".repeat(index + 1)}계획 20 ` +
  `${"다른설명 ".repeat(index + 1)}기대효과 등`
)).join("\n");
assert.equal(
  findExactEvidenceSpanCandidates(
    scoreTableRequestedSpan,
    `${scoreCandidateDecoys}\n${scoreTableExactSpan}`,
  ).includes(scoreTableExactSpan),
  true,
  "앞쪽의 장거리 후보가 많아도 가장 짧은 실제 평가표 span을 후보에 유지한다",
);
function evidenceCase(
  exactSpan: string,
  requestedSpan: string,
  dimension: CriterionDimension,
): {
  seal: ReturnType<typeof sealDeepAnalysisInput>;
  execution: DeepAnalysisExecution;
} {
  const caseSeal = sealDeepAnalysisInput({
    grantId: `evidence-${dimension}`,
    sourceRevisionSha256: "e".repeat(64),
    structuredText: exactSpan,
    attachments: [],
  });
  const caseResult: DeepAnalysisModelResult = {
    ...result,
    criteria: [{
      ...result.criteria[0]!,
      dimension,
      sourceSpan: requestedSpan,
    }],
  };
  return {
    seal: caseSeal,
    execution: {
      evidenceText: renderDeepAnalysisChunks(caseSeal.chunks),
      result: caseResult,
      passes: [{
        kind: "single",
        chunkId: null,
        inputChars: requestedSpan.length,
        result: caseResult,
      }],
    },
  };
}

const scoreTableCase = evidenceCase(
  scoreTableExactSpan,
  scoreTableRequestedSpan,
  "other",
);
const evidenceOnlyValidation = {
  ...validation,
  issues: [validation.issues[0]!],
  axisCoverageComplete: true,
};
const deterministicScoreRepair = repairDeepAnalysisEvidenceSpansDeterministically({
  execution: scoreTableCase.execution,
  validation: evidenceOnlyValidation,
});
assert.equal(deterministicScoreRepair.repairs.length, 1);
assert.equal(
  deterministicScoreRepair.execution.result.criteria[0]?.sourceSpan,
  scoreTableExactSpan,
);
assert.equal(
  deterministicScoreRepair.execution.result.criteria[0]?.spanVerified,
  true,
);
assert.equal(
  deterministicScoreRepair.execution.passes,
  scoreTableCase.execution.passes,
);
assert.deepEqual(
  deterministicScoreRepair.execution.deterministicEvidenceRepairs,
  deterministicScoreRepair.repairs,
);

const scoreTableAxes = CRITERION_DIMENSIONS.map((dimension) => ({
  dimension,
  status: dimension === "other"
    ? "condition_found" as const
    : "inspected_no_condition" as const,
  confidence: 0.9,
  comment: "전문 검사",
}));
const validScoreTableResult: DeepAnalysisModelResult = {
  ...scoreTableCase.execution.result,
  criteria: [{
    ...scoreTableCase.execution.result.criteria[0]!,
    operator: "text_only",
    value: { note: "참가 계획 평가 20점" },
  }],
  axisAssessments: scoreTableAxes,
  rawToolInput: {
    criteria: [{
      dimension: "other",
      operator: "text_only",
      kind: "preferred",
      value: { note: "참가 계획 평가 20점" },
      confidence: 0.7,
      source_span: scoreTableRequestedSpan,
    }],
    axis_assessments: scoreTableAxes.map((axis) => ({
      dimension: axis.dimension,
      status: axis.status,
      confidence: axis.confidence,
      comment: axis.comment,
    })),
  },
};
const validScoreTableExecution: DeepAnalysisExecution = {
  ...scoreTableCase.execution,
  result: validScoreTableResult,
  passes: [{
    kind: "single",
    chunkId: null,
    inputChars: scoreTableRequestedSpan.length,
    result: validScoreTableResult,
  }],
};
const initialScoreTableValidation = validateDeepAnalysisResult({
  seal: scoreTableCase.seal,
  result: validScoreTableResult,
});
assert.equal(initialScoreTableValidation.valid, false);
assert.deepEqual(
  initialScoreTableValidation.issues.map((issue) => issue.code),
  ["evidence_not_grounded"],
);
let deterministicFallbackModelCalled = false;
const locallyRepairedScoreTable = await repairDeepAnalysisExecution({
  seal: scoreTableCase.seal,
  apiKey: "test",
  model: "claude-opus-4-8",
  failedExecution: validScoreTableExecution,
  validation: initialScoreTableValidation,
  runModel: async () => {
    deterministicFallbackModelCalled = true;
    throw new Error("unique safe source_span must not call the model");
  },
});
assert.equal(deterministicFallbackModelCalled, false);
assert.equal(locallyRepairedScoreTable.passes.length, 1);
assert.equal(locallyRepairedScoreTable.result.costUsd, result.costUsd);
assert.equal(locallyRepairedScoreTable.deterministicEvidenceRepairs?.length, 1);
assert.equal(validateDeepAnalysisResult({
  seal: scoreTableCase.seal,
  result: locallyRepairedScoreTable.result,
}).valid, true);

const matchingScopeSpan = "신청서에 허위 또는 과장된 정보가 있는 경우 지원을 취소한다.";
const matchingScopeSeal = sealDeepAnalysisInput({
  grantId: "matching-scope-repair",
  sourceRevisionSha256: "d".repeat(64),
  structuredText: matchingScopeSpan,
  attachments: [],
});
const matchingScopeAxes = CRITERION_DIMENSIONS.map((dimension) => ({
  dimension,
  status: dimension === "other"
    ? "condition_found" as const
    : "inspected_no_condition" as const,
  confidence: 0.9,
  comment: "전문 검사",
}));
const nonMatchingCriterion = {
  dimension: "other" as const,
  kind: "exclusion" as const,
  operator: "text_only" as const,
  value: { note: matchingScopeSpan },
  confidence: 0.9,
  sourceSpan: matchingScopeSpan,
  spanVerified: true,
  spanOffsetRatio: 0,
  note: null,
};
const matchingScopeResult: DeepAnalysisModelResult = {
  ...result,
  criteria: [nonMatchingCriterion],
  axisAssessments: matchingScopeAxes,
  rawToolInput: {
    criteria: [{
      dimension: nonMatchingCriterion.dimension,
      kind: nonMatchingCriterion.kind,
      operator: nonMatchingCriterion.operator,
      value: nonMatchingCriterion.value,
      confidence: nonMatchingCriterion.confidence,
      source_span: nonMatchingCriterion.sourceSpan,
    }],
    axis_assessments: matchingScopeAxes.map((axis) => ({
      dimension: axis.dimension,
      status: axis.status,
      confidence: axis.confidence,
      comment: axis.comment,
    })),
  },
};
const matchingScopeExecution: DeepAnalysisExecution = {
  result: matchingScopeResult,
  evidenceText: renderDeepAnalysisChunks(matchingScopeSeal.chunks),
  passes: [{
    kind: "single",
    chunkId: null,
    inputChars: matchingScopeSpan.length,
    result: matchingScopeResult,
  }],
};
const matchingScopeValidation = validateDeepAnalysisResult({
  seal: matchingScopeSeal,
  result: matchingScopeResult,
});
assert.deepEqual(
  matchingScopeValidation.issues.map((issue) => issue.code),
  ["non_matching_criterion"],
);
const deterministicMatchingScopeRepair =
  repairDeepAnalysisMatchingScopeDeterministically({
    execution: matchingScopeExecution,
    validation: matchingScopeValidation,
  });
assert.equal(deterministicMatchingScopeRepair.repairs.length, 1);
assert.equal(deterministicMatchingScopeRepair.execution.result.criteria.length, 0);
assert.equal(
  deterministicMatchingScopeRepair.execution.result.axisAssessments
    .find((axis) => axis.dimension === "other")?.status,
  "inspected_no_condition",
);
assert.equal(
  validateDeepAnalysisResult({
    seal: matchingScopeSeal,
    result: deterministicMatchingScopeRepair.execution.result,
  }).valid,
  true,
);
let matchingScopeFallbackModelCalled = false;
const locallyRepairedMatchingScope = await repairDeepAnalysisExecution({
  seal: matchingScopeSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  failedExecution: matchingScopeExecution,
  validation: matchingScopeValidation,
  runModel: async () => {
    matchingScopeFallbackModelCalled = true;
    throw new Error("deterministic matching-scope repair must not call the model");
  },
});
assert.equal(matchingScopeFallbackModelCalled, false);
assert.equal(locallyRepairedMatchingScope.passes.length, 1);
assert.equal(locallyRepairedMatchingScope.deterministicMatchingScopeRepairs?.length, 1);

const axisSyncSpan = "사업영위 기간 10년 이상인 기업";
const axisSyncSeal = sealDeepAnalysisInput({
  grantId: "axis-status-repair",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: axisSyncSpan,
  attachments: [],
});
const axisSyncAxes = CRITERION_DIMENSIONS.map((dimension) => ({
  dimension,
  status: "inspected_no_condition" as const,
  confidence: 0.9,
  comment: "전문 검사",
}));
const axisSyncCriterion = {
  dimension: "biz_age" as const,
  kind: "required" as const,
  operator: "gte" as const,
  value: { min_months: 120 },
  confidence: 0.95,
  sourceSpan: axisSyncSpan,
  spanVerified: true,
  spanOffsetRatio: 0,
  note: null,
};
const axisSyncResult: DeepAnalysisModelResult = {
  ...result,
  criteria: [axisSyncCriterion],
  axisAssessments: axisSyncAxes,
  rawToolInput: {
    criteria: [{
      dimension: axisSyncCriterion.dimension,
      kind: axisSyncCriterion.kind,
      operator: axisSyncCriterion.operator,
      value: axisSyncCriterion.value,
      confidence: axisSyncCriterion.confidence,
      source_span: axisSyncCriterion.sourceSpan,
    }],
    axis_assessments: axisSyncAxes.map((axis) => ({
      dimension: axis.dimension,
      status: axis.status,
      confidence: axis.confidence,
      comment: axis.comment,
    })),
  },
};
const axisSyncExecution: DeepAnalysisExecution = {
  result: axisSyncResult,
  evidenceText: renderDeepAnalysisChunks(axisSyncSeal.chunks),
  passes: [{
    kind: "single",
    chunkId: null,
    inputChars: axisSyncSpan.length,
    result: axisSyncResult,
  }],
};
const axisSyncValidation = validateDeepAnalysisResult({
  seal: axisSyncSeal,
  result: axisSyncResult,
});
assert.deepEqual(
  axisSyncValidation.issues.map((issue) => [issue.code, issue.path]),
  [["axis_criterion_mismatch", "$.criteria.biz_age"]],
);
const deterministicAxisSync = repairDeepAnalysisAxisStatusesDeterministically({
  execution: axisSyncExecution,
  validation: axisSyncValidation,
});
assert.equal(deterministicAxisSync.repairs.length, 1);
assert.equal(
  deterministicAxisSync.execution.result.axisAssessments
    .find((axis) => axis.dimension === "biz_age")?.status,
  "condition_found",
);
assert.equal(
  (deterministicAxisSync.execution.result.rawToolInput.axis_assessments as Array<Record<string, unknown>>)
    .find((axis) => axis.dimension === "biz_age")?.status,
  "condition_found",
  "정규화 결과와 raw tool input을 대칭으로 교정한다",
);
assert.equal(validateDeepAnalysisResult({
  seal: axisSyncSeal,
  result: deterministicAxisSync.execution.result,
}).valid, true);
let axisSyncFallbackModelCalled = false;
const locallyRepairedAxisSync = await repairDeepAnalysisExecution({
  seal: axisSyncSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  failedExecution: axisSyncExecution,
  validation: axisSyncValidation,
  runModel: async () => {
    axisSyncFallbackModelCalled = true;
    throw new Error("safe axis status repair must not call the model");
  },
});
assert.equal(axisSyncFallbackModelCalled, false);
assert.equal(locallyRepairedAxisSync.deterministicAxisRepairs?.length, 1);

for (const heldStatus of ["ambiguous", "input_missing"] as const) {
  const heldAxes = axisSyncAxes.map((axis) => axis.dimension === "biz_age"
    ? { ...axis, status: heldStatus }
    : axis);
  const heldResult: DeepAnalysisModelResult = {
    ...axisSyncResult,
    axisAssessments: heldAxes,
    rawToolInput: {
      ...axisSyncResult.rawToolInput,
      axis_assessments: heldAxes.map((axis) => ({
        dimension: axis.dimension,
        status: axis.status,
        confidence: axis.confidence,
        comment: axis.comment,
      })),
    },
  };
  const heldExecution: DeepAnalysisExecution = {
    ...axisSyncExecution,
    result: heldResult,
  };
  const heldValidation = validateDeepAnalysisResult({
    seal: axisSyncSeal,
    result: heldResult,
  });
  assert.deepEqual(
    repairDeepAnalysisAxisStatusesDeterministically({
      execution: heldExecution,
      validation: heldValidation,
    }),
    { execution: heldExecution, repairs: [] },
    `${heldStatus}는 실제 보류 의미이므로 condition_found로 자동 교정하지 않는다`,
  );
}

const emptyFoundAxes = axisSyncAxes.map((axis) => axis.dimension === "biz_age"
  ? { ...axis, status: "condition_found" as const }
  : axis);
const emptyFoundResult: DeepAnalysisModelResult = {
  ...axisSyncResult,
  criteria: [],
  axisAssessments: emptyFoundAxes,
  rawToolInput: {
    criteria: [],
    axis_assessments: emptyFoundAxes.map((axis) => ({
      dimension: axis.dimension,
      status: axis.status,
      confidence: axis.confidence,
      comment: axis.comment,
    })),
  },
};
const emptyFoundExecution: DeepAnalysisExecution = {
  ...axisSyncExecution,
  result: emptyFoundResult,
};
assert.deepEqual(
  repairDeepAnalysisAxisStatusesDeterministically({
    execution: emptyFoundExecution,
    validation: validateDeepAnalysisResult({
      seal: axisSyncSeal,
      result: emptyFoundResult,
    }),
  }),
  { execution: emptyFoundExecution, repairs: [] },
  "criterion 없는 condition_found를 반대 방향으로 추측 교정하지 않는다",
);

const awardScoreExactSpan =
  "무역의날 수출탑 수상(최근 2 년)               개인표창 제외\n" +
  "             가점                                      2";
const awardScoreRequestedSpan =
  "· 무역의날 수출탑 수상(최근 2 년)               개인표창 제외\n" +
  "                       2";
const awardScoreCase = evidenceCase(
  awardScoreExactSpan,
  awardScoreRequestedSpan,
  "prior_award",
);
const deterministicAwardScoreRepair =
  repairDeepAnalysisEvidenceSpansDeterministically({
    execution: awardScoreCase.execution,
    validation: evidenceOnlyValidation,
  });
assert.equal(deterministicAwardScoreRepair.repairs.length, 1);
assert.equal(
  deterministicAwardScoreRepair.execution.result.criteria[0]?.sourceSpan,
  awardScoreExactSpan,
);

const semanticInsertionRequestedSpan = "서울 소재 기업 지원 대상";
const semanticInsertionExactSpan = "서울 소재 기업 지원 불가 대상";
const semanticInsertionCase = evidenceCase(
  semanticInsertionExactSpan,
  semanticInsertionRequestedSpan,
  "region",
);
assert.deepEqual(
  repairDeepAnalysisEvidenceSpansDeterministically({
    execution: semanticInsertionCase.execution,
    validation: evidenceOnlyValidation,
  }),
  { execution: semanticInsertionCase.execution, repairs: [] },
);

const numericInsertionRequestedSpan = "최근 매출 기준 이상";
const numericInsertionExactSpan = "최근 매출 2025 기준 이상";
const numericInsertionCase = evidenceCase(
  numericInsertionExactSpan,
  numericInsertionRequestedSpan,
  "revenue",
);
assert.deepEqual(
  repairDeepAnalysisEvidenceSpansDeterministically({
    execution: numericInsertionCase.execution,
    validation: evidenceOnlyValidation,
  }),
  { execution: numericInsertionCase.execution, repairs: [] },
);

const verifiedIpFinding = {
  candidateKey: "a".repeat(64),
  dimension: "ip",
  findingType: "missing_eligibility",
  reason: "평가표의 특허 보유 배점이 primary에서 누락됨",
  criterion: {
    dimension: "ip",
    operator: "in",
    kind: "preferred",
    value: { types: ["특허", "실용신안"] },
    confidence: 0.95,
    source_span: "특허ㆍ실용신안 보유 시 10점",
    needs_review: false,
    parser_version: "deep-analysis-validator-v4",
  },
};
const retryFeedback = buildDeepAnalysisAuditRetryFeedback({
  previousRunId: "deep-run-before-requeue",
  auditArtifactKey: "deep-analysis/audit.json",
  artifactText: JSON.stringify({
    schema: "deep-analysis-blind-audit-v7",
    adjudication: {
      findingValidation: {
        acceptedCount: 1,
        accepted: [verifiedIpFinding],
        rejected: [{
          code: "finding_type_mismatch",
          message: "진단용 rejected finding",
        }],
      },
      uncertaintyValidation: {
        retainedCount: 1,
      },
    },
  }),
});
assert.ok(retryFeedback);
assert.equal(
  retryFeedback.version,
  DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION,
);
assert.deepEqual(retryFeedback.findings, [verifiedIpFinding]);
assert.match(retryFeedback.taskInstruction, /관리자가 명시적으로 재처리/);
assert.match(retryFeedback.taskInstruction, /VERIFIED_AUDIT_FINDINGS/);
assert.match(retryFeedback.taskInstruction, /특허ㆍ실용신안 보유 시 10점/);
assert.equal(retryFeedback.taskInstruction.includes("진단용 rejected finding"), false);
const currentScopeFeedback = buildDeepAnalysisAuditRetryFeedback({
  previousRunId: "deep-run-v24",
  auditArtifactKey: "deep-analysis/audit-v8.json",
  artifactText: JSON.stringify({
    schema: "deep-analysis-blind-audit-v8",
    adjudication: {
      findingValidation: {
        acceptedCount: 1,
        accepted: [{
          candidateKey: "b".repeat(64),
          dimension: "region",
          findingType: "missing_eligibility",
          reason: "신청 지역 필수조건 누락",
          criterion: {
            dimension: "region",
            operator: "in",
            kind: "required",
            value: { regions: ["11"] },
            confidence: 0.95,
            source_span: "서울 소재 기업만 신청 가능",
            needs_review: false,
            parser_version: "deep-analysis-validator-v4",
          },
        }],
        rejected: [],
      },
    },
  }),
});
assert.equal(currentScopeFeedback?.findings[0]?.criterion.kind, "required");
assert.equal(
  buildDeepAnalysisAuditRetryFeedback({
    previousRunId: "deep-run-without-verified-finding",
    auditArtifactKey: "deep-analysis/audit-empty.json",
    artifactText: JSON.stringify({
      schema: "deep-analysis-blind-audit-v7",
      adjudication: {
        findingValidation: {
          acceptedCount: 0,
          accepted: [],
          rejected: [],
        },
      },
    }),
  }),
  null,
);

console.log("deep-analysis repair tests passed");
