import assert from "node:assert/strict";
import { extractGrantDocumentFields, GRANT_DOCUMENT_FIELD_PARSER_VERSION } from "../src/index.js";
import type { RequiredDocument } from "@cunote/contracts";

const documents: RequiredDocument[] = [
  {
    name: "참가신청서",
    required: true,
    source: "portal",
    category: "application_form",
    preparationType: "write",
    canonicalName: "신청서",
    sourceAttachment: "참가신청서_및_사업계획서.hwp",
    sourceSpan: "참가신청서 및 사업계획서 각 1부",
    templateRequired: true,
    confidence: 0.9,
  },
  {
    name: "사업계획서",
    required: true,
    source: "portal",
    category: "business_plan",
    preparationType: "write",
    canonicalName: "사업계획서",
    sourceAttachment: "참가신청서_및_사업계획서.hwp",
    sourceSpan: "제품 및 서비스 개발 부문 사업계획서 제출",
    templateRequired: true,
    confidence: 0.92,
  },
  {
    name: "개인정보 수집 이용 동의서",
    required: true,
    source: "portal",
    category: "consent_or_pledge",
    preparationType: "write",
    canonicalName: "동의서/서약서",
    sourceAttachment: "동의서.hwp",
    templateRequired: true,
    confidence: 0.9,
  },
  {
    name: "사업자등록증",
    required: true,
    source: "self",
    category: "business_registration",
    preparationType: "issue",
    canonicalName: "사업자등록증",
    templateRequired: false,
    confidence: 0.95,
  },
];

const fields = extractGrantDocumentFields({
  documents,
  attachmentMarkdowns: [{
    filename: "참가신청서_및_사업계획서.hwp",
    markdown: [
      "# 참가신청서 및 사업계획서",
      "",
      "지원내용",
      "■ IR 자료 제작 및 업그레이드 (필수)",
      "■ 멘토링 지원",
      "",
      "## 신청기업 정보",
      "| 항목 | 작성내용 |",
      "| --- | --- |",
      "| 기업명 |  |",
      "| 대표자 |  |",
      "| 사업자등록번호 |  |",
      "| 소재지 |  |",
      "",
      "## 사업계획",
      "1. 제품/서비스 설명:",
      "2. 이번 지원으로 달성할 목표:",
      "3. 추진 계획:",
      "4. 기대 효과:",
      "5. 예산 항목과 산출근거:",
    ].join("\n"),
  }],
});

assert.equal(fields.some((field) => field.documentCategory === "application_form"), true);
assert.equal(fields.some((field) => field.documentCategory === "business_plan"), true);
assert.equal(fields.some((field) => field.documentCategory === "consent_or_pledge"), false);
assert.equal(fields.some((field) => field.label.includes("사업자등록번호") && field.fillStrategy === "copy"), true);
assert.equal(fields.some((field) => field.label.includes("제품/서비스") && field.fillStrategy === "ask_user"), true);
assert.equal(fields.some((field) => field.label.includes("예산") && field.fieldType === "table"), true);
assert.equal(fields.some((field) => field.label.includes("IR 자료 제작")), false);
assert.equal(fields.every((field) => field.parserVersion === GRANT_DOCUMENT_FIELD_PARSER_VERSION), true);

const uniqueKeys = new Set(fields.map((field) => `${field.documentName}:${field.fieldKey}:${field.label}`));
assert.equal(uniqueKeys.size, fields.length);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "document_field_extraction_tables",
    "document_field_extraction_numbered_prompts",
    "document_field_fill_strategy",
    "document_field_false_positive_guard",
    "document_field_non_draftable_filter",
  ],
  fieldCount: fields.length,
  parserVersion: GRANT_DOCUMENT_FIELD_PARSER_VERSION,
}, null, 2));
