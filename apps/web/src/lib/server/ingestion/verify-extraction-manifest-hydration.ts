import assert from "node:assert/strict";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import { buildGrantExtractionManifest } from "@cunote/core";
import {
  mergeCurrentAttachmentArchiveState,
  mergeReviewedExtractionManifestState,
} from "../repositories/drizzle";

const grant: Grant = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "bizinfo",
  source_id: "hydrate-test",
  title: "hydrate-test",
  status: "open",
  f_regions: [],
  f_industries: [],
  f_sizes: [],
  f_founder_traits: [],
  f_required_certs: [],
  overall_confidence: 0.9,
};
const entry: NormalizedGrant<Record<string, unknown>> = {
  raw: {
    source: "bizinfo",
    source_id: "hydrate-test",
    payload: {},
    attachments: [{ filename: "공고문.hwp", url: "https://source.test/notice.hwp" }],
    status: "published",
  },
  grant,
  criteria: [{
    dimension: "region",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "경기 소재 기업",
    value: { regions: ["41"] },
  }],
};

assert.equal(buildGrantExtractionManifest(entry).readiness, "partial");

const [hydrated] = mergeCurrentAttachmentArchiveState([entry], [{
  source: "bizinfo",
  sourceId: "hydrate-test",
  filename: "공고문.hwp",
  sourceUri: "https://source.test/notice.hwp",
  archiveUrl: "https://archive.test/notice.hwp",
  storageKey: "grants/notice.hwp",
  contentType: "application/x-hwp",
  bytes: 1200,
  sha256: "abc123",
  fetchedAt: new Date("2026-07-12T00:00:00.000Z"),
  conversionStatus: null,
  markdownUrl: "https://archive.test/notice.md",
  markdownStorageKey: "grants/notice.md",
  markdownSha256: "def456",
  markdownBytes: 900,
  converter: "hwp-to-markdown-v1",
  convertedAt: new Date("2026-07-12T00:01:00.000Z"),
  conversionError: null,
}], [{
  source: "bizinfo",
  sourceId: "hydrate-test",
  title: "공고문.hwp",
  sourceAttachment: "grants/notice.hwp",
  extractionStatus: "preview_ready",
}]);

assert.ok(hydrated);
assert.equal(hydrated.raw.attachments?.[0]?.conversion?.status, "converted");
const manifest = buildGrantExtractionManifest(hydrated);
assert.equal(manifest.attachmentsFetched, 1);
assert.equal(manifest.attachmentsConverted, 1);
assert.equal(manifest.readiness, "structured_unreviewed");
assert.deepEqual(manifest.warnings, []);

const reviewedAt = "2026-07-12T02:00:00.000Z";
const [reviewed] = mergeReviewedExtractionManifestState([hydrated], [{
  grantId: hydrated.grant.id ?? null,
  output: { reviewedAt, parserVersion: "reviewer:matching-v3" },
  ts: new Date("2026-07-12T02:01:00.000Z"),
  modelVer: "fallback-model",
}]);
assert.ok(reviewed);
assert.equal(reviewed.extraction_manifest?.reviewedAt, reviewedAt);
assert.equal(reviewed.extraction_manifest?.extractorVersion, "reviewer:matching-v3");
assert.equal(reviewed.extraction_manifest?.readiness, "reviewed");

const [fallback] = mergeReviewedExtractionManifestState([hydrated], [{
  grantId: hydrated.grant.id ?? null,
  output: null,
  ts: new Date(reviewedAt),
  modelVer: "reviewer:fallback",
}]);
assert.equal(fallback?.extraction_manifest?.reviewedAt, reviewedAt);
assert.equal(fallback?.extraction_manifest?.extractorVersion, "reviewer:fallback");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "raw_attachment_pending",
    "archive_state_hydration",
    "surface_state_hydration",
    "converted_manifest_ready",
    "reviewed_log_manifest_hydration",
    "reviewed_log_metadata_fallback",
  ],
}, null, 2));
