import assert from "node:assert/strict";
import { sha256Hex } from "./sourceRevision";
import {
  sealDeepAnalysisInput,
  type DeepAnalysisInputAttachment,
} from "./inputManifest";

function attachment(overrides: Partial<DeepAnalysisInputAttachment> = {}): DeepAnalysisInputAttachment {
  const markdownText = overrides.markdownText ?? "첨부 전체 본문";
  return {
    id: "attachment-1",
    filename: "공고문.hwp",
    sourceUri: "https://example.com/notice.hwp",
    contentType: "application/x-hwp",
    bytes: 100,
    storageKey: "grant-archive/source.hwp",
    sha256: sha256Hex("source"),
    conversionStatus: "converted",
    markdownStorageKey: "grant-archive/source.md",
    markdownSha256: sha256Hex(markdownText),
    markdownText,
    loadError: null,
    ...overrides,
  };
}

const longText = "가".repeat(130_001);
const complete = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [attachment({ markdownText: longText, markdownSha256: sha256Hex(longText) })],
  chunkChars: 60_000,
});
assert.equal(complete.sealed, true);
assert.equal(complete.chunks.filter((chunk) => chunk.sourceKind === "attachment").length, 3);
assert.equal(
  complete.chunks.filter((chunk) => chunk.sourceKind === "attachment").map((chunk) => chunk.text).join(""),
  longText,
  "초대용량 첨부도 자르지 않고 chunk round-trip 되어야 한다",
);
assert.equal(complete.attachments[0]?.disposition, "included");

const missingArchive = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [attachment({ storageKey: null, sha256: null })],
});
assert.equal(missingArchive.sealed, false);
assert.equal(missingArchive.attachments[0]?.disposition, "blocked_fetch");

const missingConversion = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [attachment({
    conversionStatus: "failed",
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  })],
});
assert.equal(missingConversion.sealed, false);
assert.equal(missingConversion.attachments[0]?.disposition, "blocked_conversion");

const invalidHwpWaiver = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [attachment({
    markdownText: null,
    waiver: {
      disposition: "waived_non_material",
      reason: "양식",
      proofSha256: sha256Hex("proof"),
    },
  })],
});
assert.equal(invalidHwpWaiver.sealed, false);
assert.equal(invalidHwpWaiver.blockers[0]?.code, "invalid_waiver");

const duplicated = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [
    attachment(),
    attachment({
      id: "attachment-2",
      filename: "같은공고문.hwpx",
      sourceUri: "https://example.com/copy.hwpx",
    }),
  ],
});
assert.equal(duplicated.sealed, true);
assert.equal(duplicated.attachments[1]?.disposition, "duplicate");
assert.equal(duplicated.attachments[1]?.duplicateOf, "attachment-1");

const overCap = sealDeepAnalysisInput({
  grantId: "grant-1",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: [attachment()],
  maxTotalChars: 5,
});
assert.equal(overCap.sealed, false);
assert.equal(overCap.blockers.at(-1)?.code, "blocked_cap");

console.log("deep analysis input manifest tests passed");
