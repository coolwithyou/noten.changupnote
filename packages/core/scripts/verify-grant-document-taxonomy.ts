import assert from "node:assert/strict";
import {
  enrichGrantRequiredDocumentAttachments,
  extractGrantRequiredDocumentsFromText,
  normalizeGrantDocuments,
  normalizeGrantRequiredDocument,
  resolveGrantRequiredDocumentsFromAttachments,
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

const incidentFilename = "【붙임 1】참여신청서 및 일체서류.hwpx";
const incidentLinked = enrichGrantRequiredDocumentAttachments({
  documents: [{
    name: "참여신청서",
    required: true,
    source: "self",
    category: "application_form",
    preparation_type: "write",
    canonical_name: "신청서",
  }],
  textSources: [{
    text: incidentFilename,
    source: "portal",
    sourceAttachment: incidentFilename,
    sourceField: "attachment_filename",
  }],
});
assert.equal(incidentLinked.linkedCount, 1);
assert.equal(incidentLinked.documents[0]?.source_attachment, incidentFilename);

const explicitAttachment = enrichGrantRequiredDocumentAttachments({
  documents: [{
    name: "참여신청서",
    required: true,
    source: "portal",
    source_attachment: "검수로 확정한 신청서.hwpx",
  }],
  textSources: [{
    text: incidentFilename,
    source: "portal",
    sourceAttachment: incidentFilename,
    sourceField: "attachment_filename",
  }],
});
assert.equal(explicitAttachment.documents[0]?.source_attachment, "검수로 확정한 신청서.hwpx");

const ambiguousAttachment = enrichGrantRequiredDocumentAttachments({
  documents: [{ name: "신청서", required: true, source: "portal" }],
  textSources: ["신청서 A.hwpx", "신청서 B.hwpx"].map((filename) => ({
    text: filename,
    source: "portal" as const,
    sourceAttachment: filename,
    sourceField: "attachment_filename",
  })),
});
assert.equal(ambiguousAttachment.documents[0]?.source_attachment, undefined);
assert.equal(ambiguousAttachment.ambiguousCount, 1);

const inferredTemplates = resolveGrantRequiredDocumentsFromAttachments({
  documents: [],
  textSources: [
    "화성시 참가신청서(예비창업자용).hwpx",
    "화성시 참가신청서(기창업자용).hwpx",
    "화성시 사업계획서.hwp",
    "화성시 모집공고문.hwp",
    "참가신청서.pdf",
  ].map((filename) => ({
    text: filename,
    source: "portal" as const,
    sourceAttachment: filename,
    sourceField: "attachment_filename",
  })),
});
assert.equal(inferredTemplates.inferredCount, 3);
assert.deepEqual(
  inferredTemplates.documents.map((document) => document.source_attachment),
  [
    "화성시 참가신청서(예비창업자용).hwpx",
    "화성시 참가신청서(기창업자용).hwpx",
    "화성시 사업계획서.hwp",
  ],
);
assert.equal(inferredTemplates.documents.some((document) => document.name.includes("모집공고")), false);
assert.equal(inferredTemplates.documents.some((document) => document.source_attachment?.endsWith(".pdf")), false);

const existingTemplateWins = resolveGrantRequiredDocumentsFromAttachments({
  documents: [{ name: "참가신청서", required: true, source: "portal" }],
  textSources: [{
    text: "참가신청서.hwpx",
    source: "portal",
    sourceAttachment: "참가신청서.hwpx",
    sourceField: "attachment_filename",
  }],
});
assert.equal(existingTemplateWins.documents.length, 1);
assert.equal(existingTemplateWins.inferredCount, 0);
assert.equal(existingTemplateWins.documents[0]?.source_attachment, "참가신청서.hwpx");

const existingPdfContext = resolveGrantRequiredDocumentsFromAttachments({
  documents: [{
    name: "사업계획서",
    required: true,
    source: "portal",
    category: "business_plan",
    preparation_type: "write",
  }],
  textSources: [{
    text: "사업계획서.pdf",
    source: "portal",
    sourceAttachment: "사업계획서.pdf",
    sourceField: "attachment_filename",
  }],
});
assert.equal(existingPdfContext.documents.length, 1);
assert.equal(existingPdfContext.inferredCount, 0);
assert.equal(existingPdfContext.documents[0]?.source_attachment, "사업계획서.pdf");

const ambiguousGenericTemplate = resolveGrantRequiredDocumentsFromAttachments({
  documents: [{ name: "신청서", required: true, source: "portal" }],
  textSources: ["신청서(예비창업자용).hwpx", "신청서(기창업자용).hwpx"].map((filename) => ({
    text: filename,
    source: "portal" as const,
    sourceAttachment: filename,
    sourceField: "attachment_filename",
  })),
});
assert.equal(ambiguousGenericTemplate.documents.length, 2);
assert.equal(ambiguousGenericTemplate.inferredCount, 2);
assert.deepEqual(ambiguousGenericTemplate.existingDocumentIndexes, [null, null]);
assert.deepEqual(
  ambiguousGenericTemplate.documents.map((document) => document.source_attachment),
  ["신청서(예비창업자용).hwpx", "신청서(기창업자용).hwpx"],
);

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
    "unambiguous_attachment_enrichment",
    "attachment_enrichment_ambiguity_guard",
    "conservative_hwp_template_inference",
    "existing_document_precedence",
    "existing_non_hwp_attachment_enrichment",
    "ambiguous_generic_template_replaced_by_variants",
  ],
  extractedCount: extracted.length,
  normalizedCount: normalized.normalizedCount,
}, null, 2));
