import assert from "node:assert/strict";
import {
  mergeArchivedKStartupAttachments,
  preserveArchivedKStartupAttachmentMetadata,
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

const refreshed = preserveArchivedKStartupAttachmentMetadata([{
  filename: "모집공고.pdf",
  url: "https://origin.example/notice.pdf",
  source_uri: "https://origin.example/notice.pdf",
}, {
  filename: "새 신청서.hwpx",
  url: "https://origin.example/new-form.hwpx",
  source_uri: "https://origin.example/new-form.hwpx",
}, {
  filename: "서식 묶음.zip",
  url: "https://origin.example/forms.zip",
  source_uri: "https://origin.example/forms.zip",
}], [{
  filename: "모집공고.pdf",
  url: "https://archive.example/notice.pdf",
  source_uri: "https://origin.example/notice.pdf",
  archive_url: "https://archive.example/notice.pdf",
  storage_key: "grant-archive/kstartup/notice.pdf",
  sha256: "abc",
}, {
  filename: "삭제된 과거 서식.hwp",
  url: "https://archive.example/old.hwp",
  source_uri: "https://origin.example/old.hwp",
  archive_url: "https://archive.example/old.hwp",
  storage_key: "grant-archive/kstartup/old.hwp",
  sha256: "old",
}, {
  filename: "서식 묶음__01__신청서.hwp",
  url: "https://archive.example/nested-form.hwp",
  source_uri: "zip:https://origin.example/forms.zip#nested-form.hwp",
  archive_url: "https://archive.example/nested-form.hwp",
  storage_key: "grant-archive/kstartup/nested-form.hwp",
  sha256: "nested",
}]);
assert.equal(refreshed.length, 4, "현재 detail에서 사라진 과거 첨부는 빼고 현존 ZIP의 자식은 유지해야 한다");
assert.equal(refreshed[0]?.storage_key, "grant-archive/kstartup/notice.pdf");
assert.equal(refreshed[0]?.sha256, "abc");
assert.equal(refreshed[1]?.storage_key, undefined, "새 첨부는 미보관 상태로 남아야 한다");
assert.equal(refreshed[3]?.storage_key, "grant-archive/kstartup/nested-form.hwp");
assert.equal(merged.find((attachment) => attachment.filename === "신청서.hwp")?.url, "https://source/app.hwp");

console.log("kstartupAttachmentSelection.test.ts: all assertions passed");
