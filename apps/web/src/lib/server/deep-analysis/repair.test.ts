import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { renderDeepAnalysisChunks, type DeepAnalysisExecution } from "./analyzer";
import { findExactEvidenceSpanCandidates } from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";
import {
  buildDeepAnalysisAuditRetryFeedback,
  buildDeepAnalysisEvidenceRepairHints,
  DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION,
  DEEP_ANALYSIS_REPAIR_VERSION,
  repairDeepAnalysisEvidenceSpansDeterministically,
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
  validatorVersion: "deep-analysis-validator-v7" as const,
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
assert.equal(DEEP_ANALYSIS_REPAIR_VERSION, "deep-analysis-repair-v3");
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
