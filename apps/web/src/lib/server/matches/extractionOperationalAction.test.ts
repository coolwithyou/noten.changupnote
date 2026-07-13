import assert from "node:assert/strict";
import { emptyAttachmentState, operationalActionFor } from "./extractionOperationalAction";

const empty = emptyAttachmentState();
assert.equal(operationalActionFor("register_or_convert_attachments", 2, empty), "archive_attachments");
assert.equal(
  operationalActionFor("register_or_convert_attachments", 2, empty, 0),
  "backfill_attachment_metadata",
);
assert.equal(
  operationalActionFor("register_or_convert_attachments", 2, empty, 0, 1),
  "inspect_unsupported_attachments",
);
assert.equal(
  operationalActionFor("register_or_convert_attachments", 2, empty, 0, 1, 1),
  "ocr_images",
);
assert.equal(operationalActionFor("register_or_convert_attachments", 2, empty, 1), "archive_attachments");
assert.equal(operationalActionFor("register_or_convert_attachments", 0, empty), "register_attachment_surfaces");
assert.equal(operationalActionFor("register_or_convert_attachments", 1, {
  ...empty,
  archivedCount: 1,
  validArchivedCount: 1,
  surfaceCount: 1,
  pendingUnlinkedSurfaceCount: 1,
}), "repair_attachment_linkage");
assert.equal(operationalActionFor("register_or_convert_attachments", 1, {
  ...empty,
  archivedCount: 1,
  validArchivedCount: 1,
  surfaceCount: 1,
  pendingLinkedSurfaceCount: 1,
}), "convert_attachments");
assert.equal(operationalActionFor("register_or_convert_attachments", 1, {
  ...empty,
  archivedCount: 1,
  validArchivedCount: 1,
  surfaceCount: 1,
  convertedSurfaceCount: 1,
}), "human_review");
assert.equal(operationalActionFor(["register_or_convert_attachments", "reextract", "human_review"], 1, {
  ...empty,
  archivedCount: 1,
  validArchivedCount: 1,
  surfaceCount: 1,
  convertedSurfaceCount: 1,
}), "reextract");
assert.equal(operationalActionFor(["archive_attachments", "human_review"], 1, {
  ...empty,
  archivedCount: 1,
  validArchivedCount: 1,
  surfaceCount: 1,
  convertedSurfaceCount: 1,
}), "human_review");
assert.equal(operationalActionFor("reextract", 3, empty), "reextract");

console.log("extraction-operational-action: ok");
