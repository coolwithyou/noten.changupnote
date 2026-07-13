import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const report = readFileSync("apps/web/src/lib/server/matches/report-extraction-improvement-priority.ts", "utf8");
const pollCli = readFileSync("apps/web/src/lib/server/conversion/poll-conversion-jobs.ts", "utf8");
const pollCore = readFileSync("apps/web/src/lib/server/conversion/pollConversions.ts", "utf8");
const surfaceBackfill = readFileSync("apps/web/src/lib/server/conversion/backfill-attachment-surfaces.ts", "utf8");
const kstartupArchive = readFileSync("apps/web/src/lib/server/ingestion/backfill-kstartup-attachments.ts", "utf8");
const kstartupDetailBackfill = readFileSync("apps/web/src/lib/server/ingestion/backfill-kstartup-details.ts", "utf8");
const containerInspector = readFileSync("apps/web/src/lib/server/ingestion/inspect-unsupported-grant-attachments.ts", "utf8");
const containerInspection = readFileSync("apps/web/src/lib/server/ingestion/archiveContainerInspection.ts", "utf8");
const imageOcrProbe = readFileSync("apps/web/src/lib/server/ingestion/probe-grant-image-ocr.ts", "utf8");
const imageOcrAdapter = readFileSync("apps/web/src/lib/server/ingestion/macosVisionOcr.ts", "utf8");
const paddleOcrAdapter = readFileSync("apps/web/src/lib/server/ingestion/paddleOcrImage.ts", "utf8");
const bizinfoArchive = readFileSync("apps/web/src/lib/server/ingestion/backfill-bizinfo-attachments.ts", "utf8");
const linkageRepair = readFileSync("apps/web/src/lib/server/conversion/repair-attachment-surface-links.ts", "utf8");
const operationalAction = readFileSync("apps/web/src/lib/server/matches/extractionOperationalAction.ts", "utf8");
const batchEvidence = readFileSync("apps/web/src/lib/server/matches/extractionWriteBatchEvidence.ts", "utf8");
const batchComparison = readFileSync("apps/web/src/lib/server/matches/compare-extraction-write-batch.ts", "utf8");
const archiveReceipt = readFileSync("apps/web/src/lib/server/ingestion/grantArchiveWriteReceipt.ts", "utf8");

assert.match(report, /writeMode: false/);
assert.match(report, /priorityBatches/);
assert.match(pollCli, /--sourceIds=id1,id2/);
assert.match(pollCli, /--confirm=POLL_CONVERSION_JOBS/);
assert.match(pollCore, /inArray\(surfaces\.sourceId, options\.sourceIds\)/);
assert.match(surfaceBackfill, /--confirm=REGISTER_ATTACHMENT_SURFACES/);
assert.match(surfaceBackfill, /grantAttachmentArchives\.sourceId, sourceIds/);
assert.match(kstartupArchive, /sourceIdFilter\.has\(entry\.grant\.source_id\)/);
assert.match(kstartupArchive, /--confirm=ARCHIVE_KSTARTUP_ATTACHMENTS/);
assert.match(kstartupDetailBackfill, /sourceIds supports at most/);
assert.match(kstartupDetailBackfill, /--confirm=BACKFILL_KSTARTUP_DETAILS/);
assert.match(kstartupDetailBackfill, /const write = hasFlag\("write"\)/);
assert.match(containerInspector, /writeMode: false/);
assert.match(containerInspector, /downloadAttachmentWithLimit/);
assert.match(containerInspection, /maxUncompressedBytes/);
assert.match(containerInspection, /isSuspiciousArchivePath/);
assert.match(containerInspection, /extractSupportedArchiveEntries/);
assert.match(imageOcrProbe, /writeMode: false/);
assert.match(imageOcrAdapter, /macos-vision-ocr-v1/);
assert.match(paddleOcrAdapter, /paddleocr-ppstructurev3-http-v1/);
assert.match(paddleOcrAdapter, /returnMarkdownImages: false/);
assert.match(bizinfoArchive, /sourceIdFilter\.has\(entry\.grant\.source_id\)/);
assert.match(bizinfoArchive, /--confirm=ARCHIVE_BIZINFO_ATTACHMENTS/);
assert.match(linkageRepair, /--confirm=REPAIR_ATTACHMENT_SURFACE_LINKS/);
assert.match(operationalAction, /pendingUnlinkedSurfaceCount/);
assert.match(operationalAction, /repair_attachment_linkage/);
assert.match(operationalAction, /backfill_attachment_metadata/);
assert.match(operationalAction, /inspect_unsupported_attachments/);
assert.match(operationalAction, /ocr_images/);
assert.match(report, /archiveableAttachmentCount/);
assert.match(report, /trackedCandidates/);
assert.match(batchEvidence, /writeStillRequiresExplicitCommandConfirmation/);
assert.match(batchEvidence, /partialOrUnstructuredRecommendableCount/);
assert.match(batchEvidence, /ocr_images approval batch requires --ocrProbe evidence/);
assert.match(batchEvidence, /passingArchiveGateCount !== selectedFiles\.length/);
assert.match(batchComparison, /ok: comparison\.gates\.writeOutcomeVerified/);
assert.match(batchEvidence, /write_receipt_archive_identity_missing/);
assert.match(batchEvidence, /write_receipt_ocr_provider_mismatch/);
assert.match(archiveReceipt, /archiveIdentityValid/);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "priority_report_read_only",
    "priority_batch_source_ids",
    "targeted_conversion_poll",
    "targeted_surface_registration",
    "targeted_kstartup_archive",
    "targeted_kstartup_attachment_metadata_backfill",
    "read_only_unsupported_container_inspection",
    "bounded_zip_office_extraction",
    "read_only_image_ocr_probe",
    "image_ocr_confidence_gate",
    "self_hosted_paddleocr_image_adapter",
    "targeted_bizinfo_archive",
    "targeted_attachment_linkage_repair",
    "operational_attachment_action_split",
    "write_confirmation_guards",
    "frozen_write_batch_evidence",
    "same_asof_post_write_comparison",
    "ocr_probe_exact_match_approval_gate",
    "file_level_archive_write_receipt",
  ],
}, null, 2));
