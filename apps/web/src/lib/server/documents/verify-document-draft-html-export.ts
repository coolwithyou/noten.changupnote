import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { DocumentDraft } from "@cunote/contracts";
import { documentDraftDocxContentType, renderDocumentDraftDocx } from "./draftDocxExport";
import { renderDocumentDraftHtml, renderDocumentDraftMarkdown } from "./draftHtmlExport";
import { documentDraftPdfContentType, renderDocumentDraftPdf } from "./draftPdfExport";

const draft: Pick<DocumentDraft, "documentName" | "draftMarkdown" | "filledFields" | "missingFields" | "status" | "updatedAt"> = {
  documentName: "사업계획서 <검증>",
  status: "reviewed",
  updatedAt: "2026-06-29T00:00:00.000Z",
  filledFields: {
    "제품/서비스 설명": "지원사업 탐색과 신청서 작성을 자동화합니다.",
  },
  missingFields: [{
    fieldKey: "business.apply_goal",
    label: "이번 지원으로 달성할 목표",
    reason: "지원 동기와 기대효과를 구체화하는 데 필요합니다.",
    documentName: "사업계획서 <검증>",
    category: "business_plan",
  }],
  draftMarkdown: [
    "# 사업계획서",
    "",
    "## 개요",
    "- 첫 번째 항목",
    "- 두 번째 <script>alert(1)</script> 항목",
    "",
    "| 항목 | 내용 |",
    "| --- | --- |",
    "| 지원사업 | 창업노트 |",
    "",
    "제출 전 원문을 확인합니다.",
  ].join("\n"),
};

const html = renderDocumentDraftHtml({
  draft,
  generatedAt: new Date("2026-06-29T01:00:00.000Z"),
});

assert.equal(html.startsWith("<!doctype html>"), true);
assert.equal(html.includes("<html lang=\"ko\">"), true);
assert.equal(html.includes("<h1>사업계획서 &lt;검증&gt;</h1>"), true);
assert.equal(html.includes("<h2>개요</h2>"), true);
assert.equal(html.includes("<li>두 번째 &lt;script&gt;alert(1)&lt;/script&gt; 항목</li>"), true);
assert.equal(html.includes("<table>"), true);
assert.equal(html.includes("<th>항목</th>"), true);
assert.equal(html.includes("<td>창업노트</td>"), true);
assert.equal(html.includes("자동채움 값"), true);
assert.equal(html.includes("지원사업 탐색과 신청서 작성을 자동화합니다."), true);
assert.equal(html.includes("<script>alert(1)</script>"), false);
assert.equal(html.includes("검토 완료"), true);
const markdown = renderDocumentDraftMarkdown({ draft });
assert.equal(markdown.includes("## 자동채움 값"), true);
assert.equal(markdown.includes("이번 지원으로 달성할 목표"), true);

const docx = Buffer.from(renderDocumentDraftDocx({
  draft,
  generatedAt: new Date("2026-06-29T01:00:00.000Z"),
}));
assert.equal(documentDraftDocxContentType(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
assert.equal(docx.subarray(0, 2).toString("utf8"), "PK");
assert.equal(docx.includes(Buffer.from("word/document.xml", "utf8")), true);
assert.equal(docx.includes(Buffer.from("[Content_Types].xml", "utf8")), true);
assert.equal(docx.includes(Buffer.from("사업계획서 &lt;검증&gt;", "utf8")), true);
assert.equal(docx.includes(Buffer.from("두 번째 &lt;script&gt;alert(1)&lt;/script&gt; 항목", "utf8")), true);
assert.equal(docx.includes(Buffer.from("<script>alert(1)</script>", "utf8")), false);
assert.equal(docx.includes(Buffer.from("자동채움 값", "utf8")), true);

const pdf = Buffer.from(renderDocumentDraftPdf({
  draft,
  generatedAt: new Date("2026-06-29T01:00:00.000Z"),
}));
assert.equal(documentDraftPdfContentType(), "application/pdf");
assert.equal(pdf.subarray(0, 5).toString("utf8"), "%PDF-");
assert.equal(pdf.includes(Buffer.from("/Type /Catalog", "utf8")), true);
assert.equal(pdf.includes(Buffer.from("/UniKS-UCS2-H", "utf8")), true);
assert.equal(pdf.includes(Buffer.from("<script>alert(1)</script>", "utf8")), false);
assert.equal(pdf.includes(Buffer.from("endstream", "utf8")), true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "document_draft_html_shell",
    "markdown_heading_render",
    "markdown_list_render",
    "markdown_table_render",
    "autofill_field_export",
    "html_escape",
    "draft_status_label",
    "document_draft_docx_package",
    "document_draft_docx_escape",
    "document_draft_pdf_package",
    "document_draft_pdf_korean_font_encoding",
    "document_draft_pdf_escape",
  ],
}, null, 2));
