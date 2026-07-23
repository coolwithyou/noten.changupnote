import assert from "node:assert/strict"

import {
  attachmentContentDisposition,
  isTrustedReviewAttachmentUrl,
} from "./reviewAttachmentFetch"

assert.equal(
  isTrustedReviewAttachmentUrl("bizinfo", "https://www.bizinfo.go.kr/example/공고.hwp"),
  true,
)
assert.equal(
  isTrustedReviewAttachmentUrl("kstartup", "http://www.k-startup.go.kr/file.hwpx?download=1"),
  true,
)
assert.equal(
  isTrustedReviewAttachmentUrl("bizinfo", "https://www.bizinfo.go.kr.evil.test/file.hwp"),
  false,
)
assert.equal(
  isTrustedReviewAttachmentUrl("bizinfo", "https://127.0.0.1/file.hwp"),
  false,
)
assert.equal(
  isTrustedReviewAttachmentUrl("unknown", "https://www.bizinfo.go.kr/file.hwp"),
  false,
)
assert.match(
  attachmentContentDisposition("신청서.hwp", false),
  /^inline; filename="_+\.hwp"; filename\*=UTF-8''/,
)
assert.match(attachmentContentDisposition("form.hwpx", true), /^attachment;/)

console.log("review attachment fetch tests: ok")
