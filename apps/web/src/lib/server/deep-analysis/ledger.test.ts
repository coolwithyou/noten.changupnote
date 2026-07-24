import assert from "node:assert/strict";
import {
  deepAnalysisArtifactKey,
  putImmutableDeepAnalysisArtifact,
} from "./artifacts";
import {
  buildDeepAnalysisSourceRevision,
  sha256Hex,
  stableJson,
} from "./sourceRevision";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";

const first = buildDeepAnalysisSourceRevision({
  grant: { title: "공고", status: "open", nested: { b: 2, a: 1 } },
  rawHash: "raw",
  attachments: [
    {
      sourceUri: "https://example.com/b",
      filename: "b.hwp",
      sha256: "b",
      markdownSha256: null,
      conversionStatus: "pending",
    },
    {
      sourceUri: "https://example.com/a",
      filename: "a.hwp",
      sha256: "a",
      markdownSha256: "m",
      conversionStatus: "converted",
    },
  ],
});
const reordered = buildDeepAnalysisSourceRevision({
  grant: { nested: { a: 1, b: 2 }, status: "open", title: "공고" },
  rawHash: "raw",
  attachments: [
    {
      sourceUri: "https://example.com/a",
      filename: "a.hwp",
      sha256: "a",
      markdownSha256: "m",
      conversionStatus: "converted",
    },
    {
      sourceUri: "https://example.com/b",
      filename: "b.hwp",
      sha256: "b",
      markdownSha256: null,
      conversionStatus: "pending",
    },
  ],
});
assert.equal(first.canonicalJson, reordered.canonicalJson);
assert.equal(first.sha256, reordered.sha256);
assert.notEqual(first.sha256, buildDeepAnalysisSourceRevision({
  grant: { title: "변경 공고", status: "open" },
  rawHash: "raw",
  attachments: [],
}).sha256);
assert.equal(stableJson({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");

const sourceRevisionSha256 = sha256Hex("revision");
const contentSha256 = sha256Hex("content");
const key = deepAnalysisArtifactKey({
  grantId: "018f1f11-1111-7111-8111-111111111111",
  sourceRevisionSha256,
  runId: "run-20260725-001",
  kind: "input",
  contentSha256,
  extension: "json",
});
assert.match(key, new RegExp(`${contentSha256}\\.json$`));

const objects = new Map<string, Buffer>();
const storage: R2ObjectStorage = {
  async getObjectText(objectKey) {
    return objects.get(objectKey)?.toString("utf8") ?? "";
  },
  async getObjectBytes(objectKey) {
    const body = objects.get(objectKey);
    if (!body) throw new Error("not found");
    return { body, contentType: "application/json" };
  },
  async objectExists(objectKey) {
    return objects.has(objectKey);
  },
  async putObject(input) {
    objects.set(
      input.key,
      Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body),
    );
    return { key: input.key, url: `memory://${input.key}` };
  },
  publicUrl(objectKey) {
    return `memory://${objectKey}`;
  },
  async presignGetUrl(objectKey) {
    return `memory://${objectKey}`;
  },
};

const identity = {
  grantId: "018f1f11-1111-7111-8111-111111111111",
  sourceRevisionSha256,
  runId: "run-20260725-001",
  kind: "input" as const,
  extension: "json" as const,
};
const written = await putImmutableDeepAnalysisArtifact({
  storage,
  identity,
  body: "{\"ok\":true}",
  contentType: "application/json",
});
const reused = await putImmutableDeepAnalysisArtifact({
  storage,
  identity,
  body: "{\"ok\":true}",
  contentType: "application/json",
});
assert.equal(written.reused, false);
assert.equal(reused.reused, true);
assert.equal(written.key, reused.key);
assert.equal(sha256Hex(objects.get(written.key)!), written.sha256);

console.log("deep analysis ledger tests passed");
