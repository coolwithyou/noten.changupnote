import assert from "node:assert/strict";
import type { DeepAnalysisModelResult } from "@cunote/contracts";
import { renderDeepAnalysisChunks, type DeepAnalysisExecution } from "./analyzer";
import { sealDeepAnalysisInput } from "./inputManifest";
import { repairDeepAnalysisExecution } from "./repair";

const seal = sealDeepAnalysisInput({
  grantId: "repair-grant",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: "서울 소재 기업",
  attachments: [],
});
const result: DeepAnalysisModelResult = {
  model: "claude-opus-4-8",
  analysisMarkdown: "",
  programIntent: null,
  criteria: [],
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
let repairInstruction = "";
const repaired = await repairDeepAnalysisExecution({
  seal,
  apiKey: "test",
  model: "claude-opus-4-8",
  failedExecution: execution,
  validation: {
    validatorVersion: "deep-analysis-validator-v4",
    valid: false,
    responseContractValid: true,
    axisCoverageComplete: false,
    evidenceGrounded: true,
    issues: [{
      code: "unresolved_axis",
      path: "$.axis.region",
      message: "ambiguous",
    }],
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
  },
  runModel: async (options) => {
    repairInstruction = options.taskInstruction ?? "";
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

console.log("deep-analysis repair tests passed");
