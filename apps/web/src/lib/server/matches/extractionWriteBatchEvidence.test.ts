import assert from "node:assert/strict";
import {
  buildExtractionWriteBatchManifest,
  compareExtractionWriteBatch,
  verifyArchiveWriteReceipt,
  type ArchiveDryRunEvidence,
  type ArchiveWriteReceiptEvidence,
  type BusinessNumberEvidence,
  type ImageOcrProbeEvidence,
  type ExtractionPriorityEvidence,
} from "./extractionWriteBatchEvidence";

const asOf = "2026-07-12T03:00:00.000Z";
const priority: ExtractionPriorityEvidence = {
  generatedAt: "2026-07-12T03:01:00.000Z",
  asOf,
  writeMode: false,
  grantCount: 100,
  companyCount: 30,
  candidateCount: 80,
  totalEligibleBlockedCompanyCount: 500,
  operationalActionCounts: { archive_attachments: 40 },
  priorityBatches: [{
    source: "bizinfo",
    action: "archive_attachments",
    totalCandidateCount: 40,
    selectedCount: 2,
    eligibleBlockedCompanyCount: 20,
    priorityScoreSum: 2000,
    sourceIds: ["B-1", "B-2"],
    selectedCandidates: [
      {
        sourceId: "B-1",
        operationalAction: "archive_attachments",
        eligibleBlockedCompanyCount: 10,
        priorityScore: 1000,
        extractionReadiness: "partial",
        extractionWarnings: ["attachment_fetch_incomplete"],
        attachmentState: { validArchivedCount: 0 },
      },
      {
        sourceId: "B-2",
        operationalAction: "archive_attachments",
        eligibleBlockedCompanyCount: 10,
        priorityScore: 1000,
        extractionReadiness: "partial",
        extractionWarnings: ["attachment_fetch_incomplete"],
        attachmentState: { validArchivedCount: 0 },
      },
    ],
  }, {
    source: "bizinfo",
    action: "ocr_images",
    totalCandidateCount: 10,
    selectedCount: 2,
    eligibleBlockedCompanyCount: 15,
    priorityScoreSum: 1500,
    sourceIds: ["I-1", "I-2"],
    selectedCandidates: [
      {
        sourceId: "I-1",
        operationalAction: "ocr_images",
        eligibleBlockedCompanyCount: 10,
        priorityScore: 1000,
        extractionReadiness: "partial",
        extractionWarnings: ["attachment_conversion_incomplete"],
        attachmentState: { validArchivedCount: 0 },
      },
      {
        sourceId: "I-2",
        operationalAction: "ocr_images",
        eligibleBlockedCompanyCount: 5,
        priorityScore: 500,
        extractionReadiness: "partial",
        extractionWarnings: ["attachment_conversion_incomplete"],
        attachmentState: { validArchivedCount: 0 },
      },
    ],
  }],
};
const business: BusinessNumberEvidence = {
  generatedAt: "2026-07-12T03:02:00.000Z",
  asOf,
  writeMode: false,
  grantCount: 100,
  companyCount: 30,
  pairCount: 3000,
  initialRecommendableCount: 20,
  falseIneligibleAgainstFullCount: 0,
  unsafeIneligibleAgainstFullViableCount: 0,
  extractionReadinessCounts: { reviewed: 0, structured_unreviewed: 100, partial: 2900, unstructured: 0 },
  recommendableByExtractionReadiness: { reviewed: 0, structured_unreviewed: 20, partial: 0, unstructured: 0 },
};
const dryRun: ArchiveDryRunEvidence = {
  generatedAt: "2026-07-12T03:03:00.000Z",
  asOf,
  mode: "dry-run",
  batchCandidateCount: 2,
  selectedAttachmentCount: 3,
  sourceIds: ["B-1", "B-2"],
  candidates: [
    { sourceId: "B-1", title: "one", selectedFilenames: ["one.pdf", "one.zip"] },
    { sourceId: "B-2", title: "two", selectedFilenames: ["two.hwp"] },
  ],
};

const manifest = buildExtractionWriteBatchManifest({
  priority,
  business,
  dryRun,
  source: "bizinfo",
  createdAt: new Date("2026-07-12T03:04:00.000Z"),
});
assert.equal(manifest.authorization.approved, false);
assert.equal(manifest.expectedArtifacts.selectedInputAttachmentCount, 3);
assert.match(manifest.commands.approvedWriteTemplate.display, /--confirm=ARCHIVE_BIZINFO_ATTACHMENTS/);
assert.match(manifest.commands.afterPriorityReport.display, /--trackSourceIds=B-1,B-2/);
assert.match(manifest.commands.afterPriorityReport.display, /pnpm --silent/);
assert.match(manifest.commands.comparisonTemplate.display, /--require-verified/);

const imageDryRun: ArchiveDryRunEvidence = {
  generatedAt: "2026-07-12T03:03:00.000Z",
  asOf,
  mode: "dry-run",
  batchCandidateCount: 2,
  selectedAttachmentCount: 2,
  sourceIds: ["I-1", "I-2"],
  imageOcr: "macos_vision",
  candidates: [
    { sourceId: "I-1", title: "image one", selectedFilenames: ["one.jpg"] },
    { sourceId: "I-2", title: "image two", selectedFilenames: ["two.png"] },
  ],
};
const ocrProbe: ImageOcrProbeEvidence = {
  generatedAt: "2026-07-12T03:03:30.000Z",
  asOf,
  writeMode: false,
  provider: "macos_vision",
  source: "bizinfo",
  requestedSourceIds: ["I-1", "I-2"],
  targetCount: 2,
  recognizedCount: 2,
  passingArchiveGateCount: 2,
  failureCount: 0,
  results: [
    { sourceId: "I-1", filename: "one.jpg", characterCount: 500, averageConfidence: 0.8, converter: "vision-v1" },
    { sourceId: "I-2", filename: "two.png", characterCount: 300, averageConfidence: 0.7, converter: "vision-v1" },
  ],
};
const ocrManifest = buildExtractionWriteBatchManifest({
  priority,
  business,
  dryRun: imageDryRun,
  ocrProbe,
  source: "bizinfo",
  action: "ocr_images",
  createdAt: new Date("2026-07-12T03:04:00.000Z"),
});
assert.equal(ocrManifest.ocrEvidence?.recognizedCount, 2);
assert.equal(ocrManifest.ocrEvidence?.operationalAccuracyEvidence, false);
assert.match(ocrManifest.commands.approvedWriteTemplate.display, /--imageOcr=macos_vision/);
assert.match(ocrManifest.commands.repeatOcrProbe?.display ?? "", /--provider=macos_vision/);
assert.throws(() => buildExtractionWriteBatchManifest({
  priority,
  business,
  dryRun: imageDryRun,
  ocrProbe: {
    ...ocrProbe,
    passingArchiveGateCount: 1,
    results: [{ ...ocrProbe.results[0]!, averageConfidence: 0.59 }, ocrProbe.results[1]!],
  },
  source: "bizinfo",
  action: "ocr_images",
}), /every selected image|did not pass/);
assert.throws(() => buildExtractionWriteBatchManifest({
  priority,
  business,
  dryRun: imageDryRun,
  source: "bizinfo",
  action: "ocr_images",
}), /requires --ocrProbe/);

assert.throws(() => buildExtractionWriteBatchManifest({
  priority,
  business,
  dryRun: { ...dryRun, candidates: dryRun.candidates.slice(0, 1), batchCandidateCount: 1 },
  source: "bizinfo",
}), /do not exactly match/);
assert.throws(() => buildExtractionWriteBatchManifest({
  priority,
  business: { ...business, asOf: "2026-07-13T00:00:00.000Z" },
  dryRun,
  source: "bizinfo",
}), /same asOf/);

const afterPriority: ExtractionPriorityEvidence = {
  ...priority,
  candidateCount: 78,
  totalEligibleBlockedCompanyCount: 470,
  trackedCandidates: [
    {
      sourceId: "B-1",
      activeGrantFound: true,
      source: "bizinfo",
      operationalAction: "register_attachment_surfaces",
      eligibleBlockedCompanyCount: 10,
      priorityScore: 100,
      extractionReadiness: "partial",
      extractionWarnings: ["attachment_conversion_incomplete"],
      attachmentState: { validArchivedCount: 2, surfaceCount: 0 },
    },
    {
      sourceId: "B-2",
      activeGrantFound: true,
      source: "bizinfo",
      operationalAction: "human_review",
      eligibleBlockedCompanyCount: 0,
      priorityScore: 0,
      extractionReadiness: "structured_unreviewed",
      extractionWarnings: ["criterion_review_required"],
      attachmentState: { validArchivedCount: 1, convertedSurfaceCount: 1 },
    },
  ],
};
const archiveWriteReceipt: ArchiveWriteReceiptEvidence = {
  generatedAt: "2026-07-12T03:09:00.000Z",
  asOf,
  mode: "write",
  source: "bizinfo",
  imageOcr: "none",
  sourceIds: ["B-1", "B-2"],
  selectedAttachmentCount: 3,
  succeededCount: 2,
  failedCount: 0,
  candidates: dryRun.candidates,
  results: [
    {
      sourceId: "B-1",
      selectedAttachments: [attachmentReceipt("one.pdf", "skipped"), attachmentReceipt("one.zip", "skipped")],
    },
    {
      sourceId: "B-2",
      selectedAttachments: [attachmentReceipt("two.hwp", "converted", "hwp5html")],
    },
  ],
};
const comparison = compareExtractionWriteBatch({
  manifest,
  priority: afterPriority,
  business: { ...business, initialRecommendableCount: 25 },
  writeReceipt: archiveWriteReceipt,
  comparedAt: new Date("2026-07-12T03:10:00.000Z"),
});
assert.deepEqual(comparison.deltas, {
  totalEligibleBlockedCompanyCount: -30,
  initialRecommendableCount: 5,
  candidateCount: -2,
});
assert.equal(comparison.gates.comparable, true);
assert.equal(comparison.gates.atLeastOneActionMoved, true);
assert.equal(comparison.gates.allSourceIdsGainedArchiveIdentity, true);
assert.equal(comparison.gates.readinessGateMaintained, true);
assert.equal(comparison.gates.writeReceiptVerified, true);
assert.equal(comparison.gates.writeOutcomeVerified, true);

const contaminated = compareExtractionWriteBatch({
  manifest,
  priority: { ...afterPriority, grantCount: 101 },
  business: { ...business, grantCount: 101 },
});
assert.equal(contaminated.contaminated, true);
assert.equal(contaminated.gates.comparable, false);

const noWriteComparison = compareExtractionWriteBatch({
  manifest,
  priority: {
    ...priority,
    trackedCandidates: priority.priorityBatches[0]!.selectedCandidates.map((candidate) => ({
      ...candidate,
      activeGrantFound: true,
      source: "bizinfo",
    })),
  },
  business,
});
assert.equal(noWriteComparison.gates.comparable, true);
assert.equal(noWriteComparison.gates.writeReceiptPresent, false);
assert.equal(noWriteComparison.gates.writeOutcomeVerified, false);

const ocrWriteReceipt: ArchiveWriteReceiptEvidence = {
  generatedAt: "2026-07-12T03:09:00.000Z",
  asOf,
  mode: "write",
  source: "bizinfo",
  imageOcr: "macos_vision",
  sourceIds: ["I-1", "I-2"],
  selectedAttachmentCount: 2,
  succeededCount: 2,
  failedCount: 0,
  candidates: imageDryRun.candidates,
  results: [
    {
      sourceId: "I-1",
      failureCount: 0,
      selectedAttachments: [attachmentReceipt("one.jpg", "converted", "vision-v1", "macos_vision", 0.8)],
    },
    {
      sourceId: "I-2",
      failureCount: 0,
      selectedAttachments: [attachmentReceipt("two.png", "converted", "vision-v1", "macos_vision", 0.7)],
    },
  ],
};
assert.deepEqual(verifyArchiveWriteReceipt(ocrManifest, ocrWriteReceipt), []);
assert.match(
  verifyArchiveWriteReceipt(ocrManifest, {
    ...ocrWriteReceipt,
    results: [{
      ...ocrWriteReceipt.results[0]!,
      selectedAttachments: [attachmentReceipt("one.jpg", "converted", "vision-v1", "wrong_provider", 0.8)],
    }, ocrWriteReceipt.results[1]!],
  }).join(","),
  /ocr_provider_mismatch/,
);
assert.match(
  verifyArchiveWriteReceipt(ocrManifest, { ...ocrWriteReceipt, imageOcr: "paddleocr" }).join(","),
  /ocr_selection_mismatch/,
);

console.log("extraction-write-batch-evidence: ok");

function attachmentReceipt(
  filename: string,
  conversionStatus: "converted" | "failed" | "skipped",
  converter: string | null = null,
  ocrProvider: string | null = null,
  ocrConfidence: number | null = null,
) {
  return {
    filename,
    archiveIdentityValid: true,
    sha256: "a".repeat(64),
    storageKey: `attachments/${filename}`,
    archiveUrlPresent: true,
    conversionStatus,
    converter,
    ocrProvider,
    ocrConfidence,
    conversionError: null,
  };
}
