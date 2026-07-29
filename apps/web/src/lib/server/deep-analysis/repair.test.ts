import assert from "node:assert/strict";
import type { DeepAnalysisModelResult } from "@cunote/contracts";
import { renderDeepAnalysisChunks, type DeepAnalysisExecution } from "./analyzer";
import { findExactEvidenceSpanCandidates } from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  buildDeepAnalysisEvidenceRepairHints,
  DEEP_ANALYSIS_REPAIR_VERSION,
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
  validatorVersion: "deep-analysis-validator-v4" as const,
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
assert.equal(DEEP_ANALYSIS_REPAIR_VERSION, "deep-analysis-repair-v2");
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

console.log("deep-analysis repair tests passed");
