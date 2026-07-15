import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadKStartupAttachmentMarkdowns } from "./kstartupAttachmentMarkdown";

const noticeRaw = "---\nsource_url: https://private.example\n---\n# 공고문\n지원대상 본문입니다.";
const formRaw = "신청서 본문";
const noticeBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(noticeRaw, "utf8")]);
const reads: string[] = [];
const result = await loadKStartupAttachmentMarkdowns({
  attachments: [{
    filename: "신청서 양식.hwp",
    conversion: {
      status: "converted",
      markdown_storage_key: "forms/application.md",
      markdown_bytes: Buffer.byteLength(formRaw, "utf8"),
    },
  }, {
    filename: "모집공고문.pdf",
    conversion: {
      status: "converted",
      markdown_storage_key: "notices/body.md",
      markdown_bytes: noticeBytes.length,
      markdown_sha256: sha256(noticeBytes),
    },
  }, {
    filename: "너무큰공고.pdf",
    conversion: { status: "converted", markdown_storage_key: "notices/large.md", markdown_bytes: 3_000_000 },
  }, {
    filename: "잘못된키.pdf",
    conversion: { status: "converted", markdown_storage_key: "../secret.md", markdown_bytes: 10 },
  }],
  storage: {
    async getObjectBytes(key) {
      reads.push(key);
      const body = key === "notices/body.md" ? noticeBytes : Buffer.from(formRaw, "utf8");
      return { body, contentType: "text/markdown" };
    },
  },
  maxAttachments: 3,
  maxCharsPerAttachment: 100,
  maxTotalChars: 150,
});

assert.deepEqual(reads, ["notices/body.md", "forms/application.md"]);
assert.equal(result.candidateCount, 3);
assert.equal(result.loadedCount, 2);
assert.equal(result.skippedOversizeCount, 1);
assert.equal(result.markdowns[0]?.filename, "모집공고문.pdf");
assert.doesNotMatch(result.markdowns[0]?.markdown ?? "", /private\.example|source_url/);
assert.equal(result.markdowns[0]?.declaredMarkdownSha256, sha256(noticeBytes));
assert.equal(result.markdowns[0]?.sourceMarkdownSha256, sha256(noticeBytes));
assert.equal(result.markdowns[0]?.sourceMarkdownBytes, noticeBytes.length);
assert.match(result.markdowns[0]?.loadedMarkdownSha256 ?? "", /^[a-f0-9]{64}$/);

const mismatched = await loadKStartupAttachmentMarkdowns({
  attachments: [{
    filename: "변조된공고.md",
    conversion: {
      status: "converted",
      markdown_storage_key: "notices/tampered.md",
      markdown_sha256: "0".repeat(64),
    },
  }],
  storage: {
    async getObjectBytes() {
      return { body: Buffer.from("실제 저장 본문", "utf8"), contentType: "text/markdown" };
    },
  },
});
assert.equal(mismatched.loadedCount, 0);
assert.equal(mismatched.markdowns.length, 0);
assert.match(mismatched.failures[0]?.message ?? "", /declared SHA-256 commitment/);

console.log("kstartupAttachmentMarkdown.test.ts: all assertions passed");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
