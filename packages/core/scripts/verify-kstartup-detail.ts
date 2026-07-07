import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KSTARTUP_DETAIL_PARSER_VERSION,
  parseKStartupDetailHtml,
} from "../src/index.js";

const html = readFileSync("packages/core/fixtures/kstartup-detail-178335.html", "utf8");

const { content } = parseKStartupDetailHtml(html, {
  fetchedAt: "2026-07-07T00:00:00.000Z",
});

assert.equal(content.parser_version, KSTARTUP_DETAIL_PARSER_VERSION, "parser_version must be stamped");
assert.equal(content.fetched_at, "2026-07-07T00:00:00.000Z", "fetched_at must be preserved");

// Attachments: exactly 6, each with an absolute /afile/fileDownload URL.
assert.equal(content.attachments.length, 6, "fixture must yield 6 attachments");
assert.ok(
  content.attachments.every((attachment) =>
    attachment.url.startsWith("https://www.k-startup.go.kr/afile/fileDownload/"),
  ),
  "every attachment url must be an absolute k-startup fileDownload URL",
);
assert.ok(
  content.attachments.every((attachment) => attachment.filename.trim().length > 0),
  "every attachment must carry a filename",
);
const businessPlan = content.attachments.find((attachment) => attachment.filename.includes("(별첨1)"));
assert.ok(businessPlan, "attachments must include the (별첨1) supplement");
assert.ok(businessPlan.filename.includes(".hwp"), "the (별첨1) supplement must be a .hwp file");

// Section text extraction.
assert.ok(content.apply_method_text, "apply_method_text must be extracted");
assert.ok(
  content.apply_method_text.includes("온라인 접수"),
  "apply_method_text must mention 온라인 접수",
);
assert.ok(content.submit_documents_text, "submit_documents_text must be extracted");
assert.ok(
  content.submit_documents_text.includes("사업계획서"),
  "submit_documents_text must mention 사업계획서",
);

// Missing sections return null (not thrown).
const emptySections = parseKStartupDetailHtml(
  "<html><body><p>no application sections here</p></body></html>",
);
assert.equal(emptySections.content.apply_method_text, null, "missing 신청방법 section returns null");
assert.equal(emptySections.content.submit_documents_text, null, "missing 제출서류 section returns null");
assert.deepEqual(emptySections.content.attachments, [], "no download anchors returns empty array");

// Duplicate download anchors collapse to a single attachment.
const duplicateHtml = `
<a href="/afile/fileDownload/AAA" class="btn_down"><span>다운로드</span></a>
<a class="file_bg" title="[첨부파일] dup.hwp">dup.hwp</a>
<a href="/afile/fileDownload/AAA" class="btn_down"><span>다운로드</span></a>
`;
const duplicate = parseKStartupDetailHtml(duplicateHtml);
assert.equal(duplicate.content.attachments.length, 1, "duplicate fileDownload urls collapse to one");

console.log(
  JSON.stringify(
    {
      ok: true,
      checked: [
        "detail_parser_version_stamp",
        "detail_attachments_count_and_absolute_url",
        "detail_supplement_hwp_present",
        "detail_apply_method_and_submit_sections",
        "detail_missing_sections_return_null",
        "detail_no_attachments_empty_array",
        "detail_duplicate_download_dedup",
      ],
      parser_version: content.parser_version,
      attachment_count: content.attachments.length,
      attachments: content.attachments.map((attachment) => attachment.filename),
      apply_method_preview: content.apply_method_text.split("\n").slice(0, 3),
      submit_documents_preview: content.submit_documents_text.split("\n").slice(0, 3),
    },
    null,
    2,
  ),
);
