import assert from "node:assert/strict";
import { zipSync } from "fflate";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sha256Hex } from "./sourceRevision";
import {
  sealDeepAnalysisInput,
  type DeepAnalysisInputAttachment,
} from "./inputManifest";
import { applyVerifiedAttachmentWaivers } from "./prepareInput";

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

const imageAndHwp = [
  attachment({
    id: "poster-image",
    filename: "(붙임) 2026 Agri-ESG 포스터.jpg",
    sourceUri: "https://example.com/poster.jpg",
    storageKey: null,
    sha256: null,
    conversionStatus: null,
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  }),
  attachment({
    id: "poster-hwp",
    filename: "(붙임) 2026 Agri-ESG 포스터.hwp",
    sourceUri: "https://example.com/poster.hwp",
  }),
];
const emptyStorage = {
  getObjectBytes: async () => {
    throw new Error("unexpected object read");
  },
} as unknown as R2ObjectStorage;
await applyVerifiedAttachmentWaivers(imageAndHwp, emptyStorage);
assert.equal(
  imageAndHwp[0]?.waiver,
  undefined,
  "이름만 같은 HWP는 이미지 내용과 동일하다는 기계적 증명이 아니다",
);
assert.equal(sealDeepAnalysisInput({
  grantId: "grant-image-companion",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: imageAndHwp,
}).sealed, false);

const imageAndOcrSidecar = [
  imageAndHwp[0]!,
  attachment({
    id: "poster-ocr",
    filename: "(붙임) 2026 Agri-ESG 포스터.txt",
    sourceUri: "https://example.com/poster.jpg",
  }),
];
await applyVerifiedAttachmentWaivers(imageAndOcrSidecar, emptyStorage);
assert.deepEqual(imageAndOcrSidecar[0]?.waiver, {
  disposition: "waived_non_text",
  reason: "검증된 OCR sidecar poster-ocr가 included 입력으로 연결됨",
  proofSha256: sha256Hex("첨부 전체 본문"),
});
assert.equal(sealDeepAnalysisInput({
  grantId: "grant-image-ocr",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: imageAndOcrSidecar,
}).sealed, true);

const archiveBytes = Buffer.from(zipSync({
  "form-1.hwp": new TextEncoder().encode("first form"),
  "form-2.hwp": new TextEncoder().encode("second form"),
}));
const archiveContainer = attachment({
  id: "forms-zip",
  filename: "신청서식.zip",
  sourceUri: "https://example.com/forms.zip",
  storageKey: "grant-archive/forms.zip",
  sha256: sha256Hex(archiveBytes),
  conversionStatus: "skipped",
  markdownStorageKey: null,
  markdownSha256: null,
  markdownText: null,
});
const archiveChildren = [
  attachment({
    id: "form-1",
    filename: "신청서식__01__신청서.hwp",
    sourceUri: "zip:https://example.com/forms.zip#form-1.hwp",
  }),
  attachment({
    id: "form-2",
    filename: "신청서식__02__확인서.hwp",
    sourceUri: "zip:https://example.com/forms.zip#form-2.hwp",
  }),
];
const expandedArchive = [archiveContainer, ...archiveChildren];
const archiveStorage = {
  getObjectBytes: async (key: string) => {
    assert.equal(key, "grant-archive/forms.zip");
    return { body: archiveBytes, contentType: "application/zip" };
  },
} as unknown as R2ObjectStorage;
await applyVerifiedAttachmentWaivers(expandedArchive, archiveStorage);
assert.equal(expandedArchive[0]?.waiver?.disposition, "waived_non_material");
assert.match(expandedArchive[0]?.waiver?.reason ?? "", /material entry 2건/);
assert.equal(sealDeepAnalysisInput({
  grantId: "grant-expanded-archive",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: expandedArchive,
}).sealed, true);

const expandedArchiveWithStaleDuplicate = [
  { ...archiveContainer },
  archiveChildren[0]!,
  attachment({
    ...archiveChildren[0]!,
    id: "form-1-stale",
    filename: "신청서식__03__신청서.hwp",
    conversionStatus: "skipped",
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  }),
  archiveChildren[1]!,
];
await applyVerifiedAttachmentWaivers(expandedArchiveWithStaleDuplicate, archiveStorage);
assert.equal(
  expandedArchiveWithStaleDuplicate[0]?.waiver?.disposition,
  "waived_non_material",
  "같은 ZIP entry의 과거 incomplete child가 남아도 검증된 current child를 선택해야 한다",
);
assert.equal(sealDeepAnalysisInput({
  grantId: "grant-expanded-archive-stale-duplicate",
  sourceRevisionSha256: sha256Hex("revision"),
  structuredText: "구조화 공고",
  attachments: expandedArchiveWithStaleDuplicate,
}).sealed, true);

const incompleteArchive = [
  attachment({
    id: "forms-zip-incomplete",
    filename: "신청서식.zip",
    sourceUri: "https://example.com/forms.zip",
    conversionStatus: "skipped",
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  }),
  archiveChildren[0]!,
  attachment({
    ...archiveChildren[1]!,
    conversionStatus: "failed",
    markdownStorageKey: null,
    markdownSha256: null,
    markdownText: null,
  }),
];
await applyVerifiedAttachmentWaivers(incompleteArchive, archiveStorage);
assert.equal(incompleteArchive[0]?.waiver, undefined);

const archiveWithHiddenImageBytes = Buffer.from(zipSync({
  "form-1.hwp": new TextEncoder().encode("first form"),
  "form-2.hwp": new TextEncoder().encode("second form"),
  "poster.jpg": new TextEncoder().encode("material image"),
}));
const { waiver: _verifiedArchiveWaiver, ...archiveWithoutWaiver } = archiveContainer;
const archiveWithHiddenImage = [
  {
    ...archiveWithoutWaiver,
    sha256: sha256Hex(archiveWithHiddenImageBytes),
  },
  ...archiveChildren,
];
await applyVerifiedAttachmentWaivers(archiveWithHiddenImage, {
  getObjectBytes: async () => ({
    body: archiveWithHiddenImageBytes,
    contentType: "application/zip",
  }),
} as unknown as R2ObjectStorage);
assert.equal(
  archiveWithHiddenImage[0]?.waiver,
  undefined,
  "inventory에 없는 material image가 든 ZIP은 child 문서만으로 면제하면 안 된다",
);

console.log("deep analysis input manifest tests passed");
