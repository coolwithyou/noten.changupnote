import assert from "node:assert/strict";
import {
  classifyPublishedGrantRevision,
  expandConfirmedGrantComponentIds,
  matchingAttachmentRevisionProjection,
  type PublishedGrantRevisionSnapshot,
} from "./grantRevisionInvalidation";

const current: PublishedGrantRevisionSnapshot = {
  rawHash: "hash-1",
  matchingProjectionHash: "projection-1",
  attachments: [{ filename: "guide.hwp", conversion: { status: "pending" } }],
  parserVersion: "parser-1",
  modelVer: null,
  promptVer: null,
};

assert.equal(classifyPublishedGrantRevision(null, current), "new");
assert.equal(classifyPublishedGrantRevision(current, {
  promptVer: null,
  modelVer: null,
  parserVersion: "parser-1",
  attachments: [{ conversion: { status: "pending" }, filename: "guide.hwp" }],
  rawHash: "hash-1",
  matchingProjectionHash: "projection-1",
}), "unchanged", "object key order and collection timestamps must not create a revision");
assert.equal(classifyPublishedGrantRevision(current, { ...current, rawHash: "hash-2" }), "changed");
assert.equal(classifyPublishedGrantRevision(current, {
  ...current,
  matchingProjectionHash: "projection-2",
}), "changed", "criteria/projection changes must invalidate stale match states even when raw input is unchanged");
assert.equal(classifyPublishedGrantRevision(current, {
  ...current,
  attachments: [{ filename: "guide.hwp", conversion: { status: "converted" } }],
}), "changed", "attachment extraction readiness affects the recommendation gate");
assert.equal(classifyPublishedGrantRevision(current, { ...current, parserVersion: "parser-2" }), "changed");

assert.deepEqual(expandConfirmedGrantComponentIds(["member-2"], [
  { canonicalGrantId: "canonical", memberGrantId: "member-1" },
  { canonicalGrantId: "member-1", memberGrantId: "member-2" },
  { canonicalGrantId: "other", memberGrantId: "other-member" },
]), ["canonical", "member-1", "member-2"]);

assert.deepEqual(
  matchingAttachmentRevisionProjection([{
    filename: "guide.hwp",
    archive_url: "https://signed.example/old",
    fetched_at: "2026-07-11T00:00:00Z",
    conversion: { status: "converted", converted_at: "2026-07-11T00:01:00Z", markdown_sha256: "md-1" },
  }]),
  matchingAttachmentRevisionProjection([{
    filename: "guide.hwp",
    archive_url: "https://signed.example/new",
    fetched_at: "2026-07-12T00:00:00Z",
    conversion: { status: "converted", converted_at: "2026-07-12T00:01:00Z", markdown_sha256: "md-1" },
  }]),
  "signed URLs and collection/conversion timestamps must not create a matching revision",
);
assert.notDeepEqual(
  matchingAttachmentRevisionProjection([{ filename: "guide.hwp", conversion: { status: "pending" } }]),
  matchingAttachmentRevisionProjection([{ filename: "guide.hwp", conversion: { status: "converted", markdown_sha256: "md-1" } }]),
  "conversion readiness/content changes must create a matching revision",
);

console.log("grantRevisionInvalidation.test.ts: all assertions passed");
