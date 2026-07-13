import assert from "node:assert/strict";
import { loadKStartupAttachmentMarkdowns } from "./kstartupAttachmentMarkdown";

const reads: string[] = [];
const result = await loadKStartupAttachmentMarkdowns({
  attachments: [{
    filename: "신청서 양식.hwp",
    conversion: { status: "converted", markdown_storage_key: "forms/application.md", markdown_bytes: 100 },
  }, {
    filename: "모집공고문.pdf",
    conversion: { status: "converted", markdown_storage_key: "notices/body.md", markdown_bytes: 200 },
  }, {
    filename: "너무큰공고.pdf",
    conversion: { status: "converted", markdown_storage_key: "notices/large.md", markdown_bytes: 3_000_000 },
  }, {
    filename: "잘못된키.pdf",
    conversion: { status: "converted", markdown_storage_key: "../secret.md", markdown_bytes: 10 },
  }],
  storage: {
    async getObjectText(key) {
      reads.push(key);
      if (key === "notices/body.md") return "---\nsource_url: https://private.example\n---\n# 공고문\n지원대상 본문입니다.";
      return "신청서 본문";
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

console.log("kstartupAttachmentMarkdown.test.ts: all assertions passed");
