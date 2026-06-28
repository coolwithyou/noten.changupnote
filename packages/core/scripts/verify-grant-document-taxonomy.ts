import assert from "node:assert/strict";
import {
  extractGrantRequiredDocumentsFromText,
  normalizeGrantDocuments,
  normalizeGrantRequiredDocument,
} from "../src/index.js";

const businessPlan = normalizeGrantRequiredDocument({
  name: "제품 및 서비스 개발 부문 사업계획서",
  required: true,
  source: "portal",
  source_span: "제품 및 서비스 개발 부문 사업계획서 제출",
});
assert.equal(businessPlan.category, "business_plan");
assert.equal(businessPlan.preparation_type, "write");
assert.equal(businessPlan.template_required, true);

const issued = normalizeGrantRequiredDocument({
  name: "국세 및 지방세 완납증명서",
  required: true,
  source: "self",
  source_span: "국세 및 지방세 완납증명서 제출",
});
assert.equal(issued.category, "financial_tax");
assert.equal(issued.preparation_type, "issue");

const corporateRegister = normalizeGrantRequiredDocument({
  name: "법인등기부등본",
  required: true,
  source: "self",
  source_span: "2. 사업자등록증, 법인등기부등본 각 1부",
});
assert.equal(corporateRegister.category, "corporate_register");
assert.equal(corporateRegister.preparation_type, "issue");
assert.equal(corporateRegister.canonical_name, "법인등기부등본");

const extracted = extractGrantRequiredDocumentsFromText([{
  source: "portal",
  sourceAttachment: "참가신청서_및_사업계획서.hwp",
  text: [
    "제출서류",
    "1. 참가신청서",
    "2. 제품 및 서비스 개발 부문 사업계획서",
    "3. 개인정보 수집·이용 동의서",
    "4. 사업자등록증 및 법인등기부등본",
    "5. 국세·지방세 완납증명서",
  ].join("\n"),
}]);
assert.equal(extracted.some((document) => document.category === "application_form"), true);
assert.equal(extracted.some((document) => document.category === "business_plan"), true);
assert.equal(extracted.some((document) => document.category === "consent_or_pledge"), true);
assert.equal(extracted.some((document) => document.category === "business_registration"), true);
assert.equal(extracted.some((document) => document.category === "financial_tax"), true);

const normalized = normalizeGrantDocuments({
  documents: [{
    name: "참가신청서",
    required: true,
    source: "portal",
  }],
  textSources: [{
    source: "portal",
    sourceAttachment: "제출서류.hwp",
    text: "참가신청서, 사업계획서, 사업자등록증, 개인정보 동의서 제출",
  }],
});
assert.equal(normalized.documents.filter((document) => document.category === "application_form").length, 1);
assert.equal(normalized.documents.some((document) => document.category === "business_plan"), true);
assert.equal(normalized.categoryCounts.business_plan, 1);
assert.equal(normalized.preparationCounts.write >= 2, true);

const markdownExtracted = extractGrantRequiredDocumentsFromText([{
  source: "portal",
  sourceAttachment: "공고문.hwp",
  sourceField: "attachment_markdown",
  text: [
    "지원내용",
    "■ IR 자료 제작 및 업그레이드 (필수)",
    "■ 멘토링 지원",
    "제출서류",
    "1. 참가신청서",
    "2. 사업계획서",
  ].join("\n"),
}]);
assert.equal(markdownExtracted.some((document) => document.name.includes("IR 자료")), false);
assert.equal(markdownExtracted.some((document) => document.category === "application_form"), true);
assert.equal(markdownExtracted.some((document) => document.category === "business_plan"), true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "document_taxonomy_normalize",
    "document_text_reextract",
    "document_dedup",
    "document_counts",
    "document_section_filter",
  ],
  extractedCount: extracted.length,
  normalizedCount: normalized.normalizedCount,
}, null, 2));
