import assert from "node:assert/strict";
import type { GrantAttachmentArchiveBundle } from "./grantAttachmentArchive";
import { buildGrantArchiveAttachmentReceipts } from "./grantArchiveWriteReceipt";

const bundle: GrantAttachmentArchiveBundle = {
  attachments: [
    {
      filename: "poster.png",
      url: "https://archive.test/poster.png",
      archive_url: "https://archive.test/poster.png",
      storage_key: "attachments/poster.png",
      sha256: "a".repeat(64),
      conversion: {
        status: "converted",
        converter: "macos-vision-ocr-v1",
        ocr_provider: "macos_vision",
        ocr_confidence: 0.82,
      },
    },
    {
      filename: "nested.pdf",
      url: "https://archive.test/nested.pdf",
      archive_url: "https://archive.test/nested.pdf",
      storage_key: "attachments/nested.pdf",
      sha256: "b".repeat(64),
      conversion: { status: "skipped" },
    },
  ],
  attachmentMarkdowns: [],
  archivedCount: 2,
  convertedCount: 1,
  skippedConversionCount: 1,
  failureCount: 0,
  failures: [],
};

const receipt = buildGrantArchiveAttachmentReceipts({
  selectedFilenames: ["poster.png", "missing.jpg"],
  bundle,
});
assert.equal(receipt.selectedAttachments[0]?.archiveIdentityValid, true);
assert.equal(receipt.selectedAttachments[0]?.ocrProvider, "macos_vision");
assert.equal(receipt.selectedAttachments[0]?.ocrConfidence, 0.82);
assert.equal(receipt.selectedAttachments[1]?.conversionStatus, "missing");
assert.equal(receipt.generatedAttachments[0]?.filename, "nested.pdf");

console.log("grant-archive-write-receipt: ok");
