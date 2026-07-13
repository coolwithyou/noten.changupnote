import assert from "node:assert/strict";
import {
  mergeArchivedKStartupAttachments,
  selectKStartupAttachmentsForArchive,
} from "./kstartupAttachmentSelection";

const existing = [{ filename: "신청서.hwp", url: "https://source/app.hwp", source_uri: "https://source/app.hwp" }, {
  filename: "모집공고.pdf",
  url: "https://source/notice.pdf",
  source_uri: "https://source/notice.pdf",
}, {
  filename: "포스터.jpg",
  url: "https://source/poster.jpg",
  source_uri: "https://source/poster.jpg",
}, {
  filename: "포스터 대체텍스트.txt",
  url: "https://source/poster.txt",
  source_uri: "https://source/poster.txt",
}, {
  filename: "신청서 묶음.zip",
  url: "https://source/forms.zip",
  source_uri: "https://source/forms.zip",
}];
const selected = selectKStartupAttachmentsForArchive(existing, 4);
assert.deepEqual(selected.map((attachment) => attachment.filename), [
  "모집공고.pdf",
  "포스터 대체텍스트.txt",
  "신청서 묶음.zip",
  "신청서.hwp",
]);
assert.equal(
  selectKStartupAttachmentsForArchive(existing, 10, { includeImages: true })
    .some((attachment) => attachment.filename === "포스터.jpg"),
  true,
);

const merged = mergeArchivedKStartupAttachments(existing, [{
  filename: "모집공고.pdf",
  url: "https://r2/notice.pdf",
  source_uri: "https://source/notice.pdf",
  archive_url: "https://r2/notice.pdf",
  storage_key: "grant-archive/kstartup/notice.pdf",
  sha256: "abc",
}]);
assert.equal(merged.length, 5);
assert.equal(merged.find((attachment) => attachment.filename === "모집공고.pdf")?.storage_key, "grant-archive/kstartup/notice.pdf");
assert.equal(merged.find((attachment) => attachment.filename === "신청서.hwp")?.url, "https://source/app.hwp");

console.log("kstartupAttachmentSelection.test.ts: all assertions passed");
