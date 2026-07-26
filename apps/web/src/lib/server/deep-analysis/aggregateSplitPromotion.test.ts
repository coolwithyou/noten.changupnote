import assert from "node:assert/strict";

import type * as schema from "@/lib/server/db/schema";
import { hashGrantRawPayload } from "@/lib/server/ingestion/grantRawHash";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  AGGREGATE_SPLIT_CHILD_PROJECTION_SCHEMA,
  type AggregateSplitChildDraft,
} from "./aggregateSplitMaterializer";
import {
  resolveAggregateSplitPromotionPolicy,
  verifyPreparedAggregateSplitPromotionChildren,
} from "./aggregateSplitPromotion";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  buildDeepAnalysisSourceRevision,
  sha256Hex,
  stableJson,
} from "./sourceRevision";

type AggregateSplitCase = typeof schema.grantAggregateSplitCases.$inferSelect;
type AggregateSplitChild = typeof schema.grantAggregateSplitChildren.$inferSelect;

assert.deepEqual(resolveAggregateSplitPromotionPolicy({}), {
  maxCasesPerInvocation: 1,
  jobPriority: 200,
});
assert.throws(
  () => resolveAggregateSplitPromotionPolicy({
    AGGREGATE_SPLIT_DEEP_ANALYSIS_JOB_PRIORITY: "1001",
  }),
  /between 1 and 1000/,
);

const splitCaseId = "33333333-3333-4333-8333-333333333333";
const parentGrantId = "22222222-2222-4222-8222-222222222222";
const manifestSha256 = "b".repeat(64);
const builtChildren = [
  buildPreparedChild({
    id: "44444444-4444-4444-8444-444444444444",
    ordinal: 0,
    stableKey: "p001-111111111111",
    title: "A 사업",
  }),
  buildPreparedChild({
    id: "55555555-5555-4555-8555-555555555555",
    ordinal: 1,
    stableKey: "p002-222222222222",
    title: "B 사업",
  }),
];
const splitCase = {
  id: splitCaseId,
  grantId: parentGrantId,
  status: "completed",
  materializationStatus: "prepared",
  promotionStatus: "pending",
  sourceRevisionSha256: "a".repeat(64),
  manifestSha256,
  programCount: builtChildren.length,
  preparedChildCount: builtChildren.length,
} as AggregateSplitCase;
const storage = memoryStorage(new Map(
  builtChildren.map((item) => [item.child.inputArtifactKey!, item.body]),
));
const verified = await verifyPreparedAggregateSplitPromotionChildren({
  storage,
  splitCase,
  children: builtChildren.map((item) => item.child),
  drafts: builtChildren.map((item) => item.draft),
});
assert.equal(verified.length, 2);
assert.equal(verified[0]?.grantValues.id, builtChildren[0]?.child.id);
assert.equal(verified[0]?.grantValues.servingState, "staged");
assert.equal(verified[0]?.grantValues.fAuthoringMode, "deep_analysis_pending");
assert.equal(verified[0]?.rawValues.status, "published");
assert.deepEqual(verified[0]?.rawValues.attachments, []);

await assert.rejects(
  verifyPreparedAggregateSplitPromotionChildren({
    storage: memoryStorage(new Map([
      [builtChildren[0]!.child.inputArtifactKey!, `${builtChildren[0]!.body} `],
      [builtChildren[1]!.child.inputArtifactKey!, builtChildren[1]!.body],
    ])),
    splitCase,
    children: builtChildren.map((item) => item.child),
    drafts: builtChildren.map((item) => item.draft),
  }),
  /readback hash/,
);

await assert.rejects(
  verifyPreparedAggregateSplitPromotionChildren({
    storage,
    splitCase,
    children: [{
      ...builtChildren[0]!.child,
      grantProjection: {
        ...builtChildren[0]!.child.grantProjection,
        sourceRevisionSha256: "c".repeat(64),
      },
    }, builtChildren[1]!.child],
    drafts: builtChildren.map((item) => item.draft),
  }),
  /projection\/raw\/source identity/,
);

await assert.rejects(
  verifyPreparedAggregateSplitPromotionChildren({
    storage,
    splitCase,
    children: [builtChildren[0]!.child],
    drafts: builtChildren.map((item) => item.draft),
  }),
  /모든 E-3A child/,
);

console.log("aggregate split staged promotion tests passed");

function buildPreparedChild(input: {
  id: string;
  ordinal: number;
  stableKey: string;
  title: string;
}): {
  child: AggregateSplitChild;
  draft: AggregateSplitChildDraft;
  body: string;
} {
  const sourceId = `parent::split::aaaaaaaaaaaa::${input.stableKey}`;
  const grant = {
    source: "kstartup",
    sourceId,
    title: input.title,
    url: "https://example.com/parent",
    agencyJurisdiction: "중앙",
    agencyOperator: "운영기관",
    agencyPrimary: "주관기관",
    categoryL1: "창업",
    categoryL2: "통합",
    applyStart: "2026-01-01T00:00:00.000Z",
    applyEnd: "2026-12-31T00:00:00.000Z",
    applyMethod: { online: "온라인" },
    supportAmount: null,
    benefits: null,
    requiredDocuments: null,
    status: "open",
  };
  const rawPayload = {
    schema: "aggregate-split-child-source-v1",
    provenance: {
      splitCaseId,
      parentGrantId,
      parentSource: "kstartup",
      parentSourceId: "parent",
      parentSourceRevisionSha256: "a".repeat(64),
      manifestSha256,
    },
    program: {
      stableKey: input.stableKey,
      ordinal: input.ordinal,
      title: input.title,
      agency: "주관기관",
      ownedSegmentIds: [`segment-${input.ordinal}`],
      sharedSegmentIds: [],
    },
    segments: [{ id: `segment-${input.ordinal}`, text: `${input.title} 본문` }],
  };
  const rawPayloadSha256 = hashGrantRawPayload(rawPayload);
  const sourceRevisionSha256 = buildDeepAnalysisSourceRevision({
    grant,
    rawHash: rawPayloadSha256,
    attachments: [],
  }).sha256;
  const projection = {
    schema: AGGREGATE_SPLIT_CHILD_PROJECTION_SCHEMA,
    splitCaseId,
    parentGrantId,
    stableKey: input.stableKey,
    ordinal: input.ordinal,
    grant,
    initialMatchingProjection: {
      fRegions: [],
      fIndustries: [],
      fBizAgeMinMonths: null,
      fBizAgeMaxMonths: null,
      fSizes: [],
      fFounderTraits: [],
      fRequiredCerts: [],
      fApplyMethods: [],
      fAuthoringMode: "deep_analysis_pending",
      overallConfidence: 0,
    },
    rawPayloadSha256,
    sourceRevisionSha256,
    manifestSha256,
  };
  const seal = sealDeepAnalysisInput({
    grantId: input.id,
    sourceRevisionSha256,
    structuredText: stableJson({
      schema: "deep-analysis-structured-source-v1",
      grant,
      rawPayload,
    }),
    attachments: [],
  });
  const now = new Date("2026-07-26T00:00:00.000Z");
  return {
    draft: {
      stableKey: input.stableKey,
      ordinal: input.ordinal,
      source: "kstartup",
      sourceId,
      title: input.title,
      agencyPrimary: "주관기관",
      grantProjection: projection,
      grantProjectionSha256: sha256Hex(stableJson(projection)),
      manifestSha256,
      sourceRevisionSha256,
      rawPayloadSha256,
      rawPayload,
      grantSourceFields: grant,
    },
    child: {
      id: input.id,
      splitCaseId,
      parentGrantId,
      stableKey: input.stableKey,
      ordinal: input.ordinal,
      status: "prepared",
      source: "kstartup",
      sourceId,
      title: input.title,
      agencyPrimary: "주관기관",
      grantProjection: projection,
      grantProjectionSha256: sha256Hex(stableJson(projection)),
      manifestSha256,
      sourceRevisionSha256,
      rawPayloadSha256,
      attachmentManifestSha256: seal.attachmentManifestSha256,
      inputArtifactKey: `aggregate/${input.id}.json`,
      inputSha256: seal.inputSha256,
      inputChars: seal.totalChars,
      preparedAt: now,
      stagedGrantAt: null,
      deepAnalysisJobId: null,
      deepAnalysisEnqueuedAt: null,
      activeFeederBypassReason: null,
      promotionLastErrorCode: null,
      promotionLastErrorMessage: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: now,
      updatedAt: now,
    },
    body: seal.inputArtifactBody,
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
      objects.set(input.key, String(input.body));
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
