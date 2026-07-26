import assert from "node:assert/strict";

import {
  buildAggregateSplitManifest,
  buildAggregateSplitSegments,
  runAggregateSplitModel,
  type AggregateSplitModelRunner,
} from "./aggregateSplitManifest";
import { sealDeepAnalysisInput } from "./inputManifest";

const sourceText = [
  "공통 안내\n".padEnd(1_000, "가"),
  "A 사업\n".padEnd(1_000, "나"),
  "B 사업\n".padEnd(1_000, "다"),
  "목차\n".padEnd(1_000, "라"),
].join("");
const seal = sealDeepAnalysisInput({
  grantId: "22222222-2222-4222-8222-222222222222",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: sourceText,
  attachments: [],
  chunkChars: 1_000,
  maxTotalChars: 100,
});
const segments = buildAggregateSplitSegments(seal, 1_000);
assert.equal(segments.length, 4);
assert.equal(
  segments.map((segment) => segment.text).join(""),
  sourceText,
  "segment는 원문을 무손실로 왕복해야 한다",
);

const validRunner = buildRunner();
const built = await buildAggregateSplitManifest({
  caseId: "33333333-3333-4333-8333-333333333333",
  seal,
  apiKey: "test",
  model: "test-model",
  maxChildInputChars: 3_000,
  segmentChars: 1_000,
  mapInputChars: 10_000,
  runModel: validRunner,
});
assert.equal(built.manifest.programs.length, 2);
assert.equal(built.manifest.sharedSegmentIds.length, 1);
assert.equal(built.manifest.navigationSegmentIds.length, 1);
assert.equal(built.manifest.coverage.assignedChars, sourceText.length);
assert.equal(built.manifest.coverage.assignedSegmentCount, segments.length);
assert.equal(built.manifest.programs[0]?.projectedInputChars, 2_000);
assert.equal(built.manifest.execution.externalCallsMade, 2);
assert.match(built.manifest.programs[0]?.stableKey ?? "", /^p001-[0-9a-f]{12}$/);
assert.equal("text" in built.manifest.segments[0]!, false, "manifest는 원문을 중복 저장하지 않는다");
assert.equal(built.passes.length, 2);

const adapterResult = await runAggregateSplitModel({
  apiKey: "test",
  model: "claude-opus-4-8",
  phase: "map",
  passId: "map-adapter-test",
  inputText: "segment",
  fetchImpl: async () => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      name: "emit_aggregate_split_map",
      input: {
        assignments: [{
          segment_id: "seg-adapter",
          disposition: "shared",
          provisional_program_key: "",
          program_title: "",
          agency: "",
          confidence: 1,
          reason: "fixture",
        }],
      },
    }],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
    },
  }), { status: 200 }),
});
assert.equal(adapterResult.phase, "map");
assert.equal(adapterResult.pass.externalCallsMade, 1);
assert.equal(adapterResult.pass.usage?.inputTokens, 100);

await assert.rejects(
  buildAggregateSplitManifest({
    caseId: "33333333-3333-4333-8333-333333333333",
    seal,
    apiKey: "test",
    model: "test-model",
    maxChildInputChars: 3_000,
    segmentChars: 1_000,
    mapInputChars: 10_000,
    runModel: buildRunner({ omitLastMapAssignment: true }),
  }),
  /분류하지 않았습니다/,
);

await assert.rejects(
  buildAggregateSplitManifest({
    caseId: "33333333-3333-4333-8333-333333333333",
    seal,
    apiKey: "test",
    model: "test-model",
    maxChildInputChars: 3_000,
    segmentChars: 1_000,
    mapInputChars: 10_000,
    runModel: buildRunner({ duplicateSynthesisMember: true }),
  }),
  /누락·중복·위조/,
);

console.log("aggregate split manifest tests passed");

function buildRunner(options: {
  omitLastMapAssignment?: boolean;
  duplicateSynthesisMember?: boolean;
} = {}): AggregateSplitModelRunner {
  return async (request) => {
    if (request.phase === "map") {
      const segmentIds = [...request.inputText.matchAll(/id="(seg-[^"]+)"/g)]
        .map((match) => match[1]!);
      const assignments = segmentIds.map((segmentId, index) => ({
        segmentId,
        disposition: index === 0
          ? "shared" as const
          : index === 3
            ? "navigation" as const
            : "program" as const,
        provisionalProgramKey: index === 1 ? "program-a" : index === 2 ? "program-b" : "",
        programTitle: index === 1 ? "A 사업" : index === 2 ? "B 사업" : "",
        agency: index === 1 ? "A 기관" : index === 2 ? "B 기관" : "",
        confidence: 0.99,
        reason: "fixture",
      }));
      if (options.omitLastMapAssignment) assignments.pop();
      return {
        phase: "map",
        assignments,
        pass: fakePass("map", request.passId, request.inputText.length),
      };
    }
    const firstMembers = [{
      mapPassId: "map-001",
      provisionalProgramKey: "program-a",
    }];
    if (options.duplicateSynthesisMember) {
      firstMembers.push({
        mapPassId: "map-001",
        provisionalProgramKey: "program-a",
      });
    }
    return {
      phase: "synthesis",
      programs: [{
        canonicalTitle: "A 사업",
        agency: "A 기관",
        members: firstMembers,
      }, {
        canonicalTitle: "B 사업",
        agency: "B 기관",
        members: [{
          mapPassId: "map-001",
          provisionalProgramKey: "program-b",
        }],
      }],
      pass: fakePass("synthesis", request.passId, request.inputText.length),
    };
  };
}

function fakePass(
  phase: "map" | "synthesis",
  passId: string,
  inputChars: number,
) {
  return {
    phase,
    passId,
    inputChars,
    rawResponseText: "{}",
    rawToolInput: {},
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: null,
    },
    costUsd: 0.001,
    externalCallsMade: 1,
  };
}
