import assert from "node:assert/strict";

import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  buildAggregateSplitManifest,
  type AggregateSplitModelRunner,
} from "./aggregateSplitManifest";
import {
  buildAggregateSplitChildDrafts,
  loadValidatedAggregateSplitBundle,
  sealAggregateSplitChildInput,
  type AggregateSplitCompletedCaseIdentity,
} from "./aggregateSplitMaterializer";
import { sealDeepAnalysisInput } from "./inputManifest";
import { sha256Hex, stableJson } from "./sourceRevision";

const sourceText = stableJson({
  schema: "deep-analysis-structured-source-v1",
  grant: {
    source: "kstartup",
    sourceId: "parent-source",
    title: "통합공고",
    url: "https://example.com/parent",
    agencyJurisdiction: "중앙",
    agencyOperator: "운영기관",
    agencyPrimary: "주관기관",
    categoryL1: "창업",
    categoryL2: "통합",
    applyStart: "2026-01-01T00:00:00.000Z",
    applyEnd: "2026-12-31T00:00:00.000Z",
    applyMethod: { online: "온라인" },
    supportAmount: { text: "사업별 상이" },
    benefits: [{ text: "사업별 상이" }],
    requiredDocuments: [{ text: "사업별 상이" }],
    status: "open",
  },
  rawPayload: {
    sections: [
      "공통 안내\n".padEnd(1_000, "가"),
      "A 사업\n".padEnd(1_000, "나"),
      "B 사업\n".padEnd(1_000, "다"),
      "목차\n".padEnd(1_000, "라"),
    ],
  },
});
const parentSeal = sealDeepAnalysisInput({
  grantId: "22222222-2222-4222-8222-222222222222",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: sourceText,
  attachments: [],
  chunkChars: 1_000,
  maxTotalChars: 100,
});
const built = await buildAggregateSplitManifest({
  caseId: "33333333-3333-4333-8333-333333333333",
  seal: parentSeal,
  apiKey: "test",
  model: "claude-opus-4-8",
  maxChildInputChars: 10_000,
  segmentChars: 1_000,
  mapInputChars: 10_000,
  runModel: fixtureModel,
});
const manifestBody = `${stableJson(built.manifest)}\n`;
const splitCase: AggregateSplitCompletedCaseIdentity = {
  id: built.manifest.caseId,
  grantId: built.manifest.parentGrantId,
  sourceRevisionSha256: built.manifest.sourceRevisionSha256,
  inputArtifactKey: "aggregate/input.json",
  inputSha256: parentSeal.inputSha256,
  manifestArtifactKey: "aggregate/manifest.json",
  manifestSha256: sha256Hex(manifestBody),
  model: built.manifest.model,
  segmentCount: built.manifest.coverage.segmentCount,
  programCount: built.manifest.programs.length,
};
const storage = memoryStorage(new Map([
  [splitCase.inputArtifactKey, parentSeal.inputArtifactBody],
  [splitCase.manifestArtifactKey, manifestBody],
]));
const bundle = await loadValidatedAggregateSplitBundle({
  storage,
  splitCase,
  maxChildInputChars: 10_000,
});
assert.ok(bundle.segments.length >= 4);
assert.equal(
  bundle.segments.map((segment) => segment.text).join(""),
  sourceText,
  "consumer가 parent input에서 segment text를 무손실 재구성해야 한다",
);

const drafts = buildAggregateSplitChildDrafts({
  splitCase,
  bundle,
});
assert.equal(drafts.length, 2);
assert.match(
  drafts[0]?.sourceId ?? "",
  /^parent-source::split::a{12}::p001-[0-9a-f]{12}$/,
);
assert.equal(
  (drafts[0]?.grantProjection.initialMatchingProjection as { fAuthoringMode?: string })
    .fAuthoringMode,
  "deep_analysis_pending",
);
const childSeal = sealAggregateSplitChildInput({
  childGrantId: "44444444-4444-4444-8444-444444444444",
  draft: drafts[0]!,
  maxTotalChars: 10_000,
});
assert.equal(childSeal.sealed, true);
assert.equal(childSeal.blockers.length, 0);
assert.equal(childSeal.grantId, "44444444-4444-4444-8444-444444444444");
assert.equal(childSeal.sourceRevisionSha256, drafts[0]?.sourceRevisionSha256);
assert.ok(childSeal.totalChars > built.manifest.programs[0]!.projectedInputChars);
assert.ok(childSeal.totalChars < 10_000);

const corruptedManifest = structuredClone(built.manifest);
corruptedManifest.programs[0]!.ownedChars += 1;
const corruptedBody = `${stableJson(corruptedManifest)}\n`;
await assert.rejects(
  loadValidatedAggregateSplitBundle({
    storage: memoryStorage(new Map([
      [splitCase.inputArtifactKey, parentSeal.inputArtifactBody],
      [splitCase.manifestArtifactKey, corruptedBody],
    ])),
    splitCase: {
      ...splitCase,
      manifestSha256: sha256Hex(corruptedBody),
    },
    maxChildInputChars: 10_000,
  }),
  /문자 수 evidence/,
  "content hash가 맞아도 server 재계산과 다른 manifest는 소비하면 안 된다",
);

await assert.rejects(
  loadValidatedAggregateSplitBundle({
    storage: memoryStorage(new Map([
      [splitCase.inputArtifactKey, `${parentSeal.inputArtifactBody} `],
      [splitCase.manifestArtifactKey, manifestBody],
    ])),
    splitCase,
    maxChildInputChars: 10_000,
  }),
  /readback hash/,
);

console.log("aggregate split materializer tests passed");

async function fixtureModel(
  request: Parameters<AggregateSplitModelRunner>[0],
): Promise<Awaited<ReturnType<AggregateSplitModelRunner>>> {
  if (request.phase === "map") {
    const segmentIds = [...request.inputText.matchAll(/id="(seg-[^"]+)"/g)]
      .map((match) => match[1]!);
    return {
      phase: "map",
      assignments: segmentIds.map((segmentId, index) => {
        const isProgram = index > 0 && index < segmentIds.length - 1;
        return {
          segmentId,
          disposition: index === 0
            ? "shared" as const
            : index === segmentIds.length - 1
              ? "navigation" as const
              : "program" as const,
          provisionalProgramKey: isProgram
            ? index === 1 ? "program-a" : "program-b"
            : "",
          programTitle: isProgram ? index === 1 ? "A 사업" : "B 사업" : "",
          agency: isProgram ? index === 1 ? "A 기관" : "B 기관" : "",
          confidence: 0.99,
          reason: "fixture",
        };
      }),
      pass: fakePass("map", request.passId, request.inputText.length),
    };
  }
  return {
    phase: "synthesis",
    programs: [{
      canonicalTitle: "A 사업",
      agency: "A 기관",
      members: [{ mapPassId: "map-001", provisionalProgramKey: "program-a" }],
    }, {
      canonicalTitle: "B 사업",
      agency: "B 기관",
      members: [{ mapPassId: "map-001", provisionalProgramKey: "program-b" }],
    }],
    pass: fakePass("synthesis", request.passId, request.inputText.length),
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

function memoryStorage(objects: Map<string, string>): R2ObjectStorage {
  return {
    async getObjectText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`missing object: ${key}`);
      return value;
    },
    async getObjectBytes(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`missing object: ${key}`);
      return { body: Buffer.from(value), contentType: "application/json" };
    },
    async objectExists(key) {
      return objects.has(key);
    },
    async putObject(input) {
      objects.set(
        input.key,
        typeof input.body === "string" ? input.body : input.body.toString("utf8"),
      );
      return { key: input.key, url: input.key };
    },
    publicUrl(key) {
      return key;
    },
    async presignGetUrl(key) {
      return key;
    },
  };
}
