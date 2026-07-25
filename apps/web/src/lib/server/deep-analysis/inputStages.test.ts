import assert from "node:assert/strict";
import { sealDeepAnalysisInput } from "./inputManifest";
import { buildDeepAnalysisInputStageReceipts } from "./inputStages";
import { sha256Hex } from "./sourceRevision";

const seal = sealDeepAnalysisInput({
  grantId: "grant",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "공고",
  attachments: [{
    id: "missing",
    filename: "공고문.hwp",
    sourceUri: "https://example.com/notice.hwp",
    contentType: "application/x-hwp",
    bytes: null,
    storageKey: null,
    sha256: null,
    conversionStatus: null,
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  }],
});
const receipts = buildDeepAnalysisInputStageReceipts(seal);
assert.deepEqual(receipts.map((receipt) => [receipt.stage, receipt.status]), [
  ["source_fresh", "passed"],
  ["attachment_inventory_complete", "passed"],
  ["attachment_archive_complete", "blocked"],
  ["attachment_text_complete", "blocked"],
  ["input_coverage_verified", "blocked"],
  ["input_sealed", "blocked"],
]);

console.log("deep analysis input stage tests passed");
