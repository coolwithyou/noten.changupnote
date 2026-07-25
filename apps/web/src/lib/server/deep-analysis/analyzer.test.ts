import assert from "node:assert/strict";
import type { DeepAnalysisModelResult } from "@cunote/contracts";
import { analyzeSealedDeepAnalysisInput } from "./analyzer";
import { sealDeepAnalysisInput } from "./inputManifest";
import type { runDeepGrantAnalysis } from "./extractor";

function modelResult(model: string): DeepAnalysisModelResult {
  return {
    model,
    analysisMarkdown: "# 분석",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null },
    costUsd: 0.25,
    rawToolInput: {},
    rawResponseText: "{}",
    stopReason: "tool_use",
  };
}

const calls: Array<Parameters<typeof runDeepGrantAnalysis>[0]> = [];
const fakeRunner = async (
  options: Parameters<typeof runDeepGrantAnalysis>[0],
): Promise<DeepAnalysisModelResult> => {
  calls.push(options);
  return modelResult(options.model ?? "unknown");
};

const shortSeal = sealDeepAnalysisInput({
  grantId: "grant-short",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: "짧은 공고",
  attachments: [],
});
const single = await analyzeSealedDeepAnalysisInput({
  seal: shortSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  runModel: fakeRunner,
});
assert.equal(single.passes.length, 1);
assert.equal(single.passes[0]?.kind, "single");
assert.equal(calls.length, 1);

calls.length = 0;
const longSeal = sealDeepAnalysisInput({
  grantId: "grant-long",
  sourceRevisionSha256: "b".repeat(64),
  structuredText: "가".repeat(2_500),
  attachments: [],
  chunkChars: 1_000,
});
const reduced = await analyzeSealedDeepAnalysisInput({
  seal: longSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  singlePromptChars: 1_100,
  runModel: fakeRunner,
});
assert.equal(reduced.passes.filter((pass) => pass.kind === "map").length, 3);
assert.equal(reduced.passes.at(-1)?.kind, "synthesis");
assert.equal(calls.length, 4);
assert.equal(reduced.result.usage?.inputTokens, 40);
assert.equal(reduced.result.usage?.outputTokens, 20);
assert.equal(reduced.result.costUsd, 1);
assert.equal(calls.at(-1)?.evidenceText, reduced.evidenceText);
assert.match(calls.at(-1)?.taskInstruction ?? "", /최종 22축/);

console.log("deep-analysis analyzer tests passed");
