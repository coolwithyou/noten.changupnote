import assert from "node:assert/strict";
import { buildDocumentPreparation, generateDocumentDraftContent } from "../src/index.js";
import type { GrantDetail, RequiredDocument } from "@cunote/contracts";

const documents: RequiredDocument[] = [
  {
    name: "참가신청서",
    required: true,
    source: "portal",
    category: "application_form",
    preparationType: "write",
    canonicalName: "신청서",
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
    sourceAttachment: "사업계획서.hwp",
    templateRequired: true,
    confidence: 0.9,
  },
  {
    name: "개인정보 수집 이용 동의서",
    required: true,
    source: "portal",
    category: "consent_or_pledge",
    preparationType: "write",
    canonicalName: "동의서/서약서",
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
  {
    name: "통장사본",
    required: true,
    source: "self",
    category: "bank_account",
    preparationType: "attach",
    canonicalName: "통장사본",
    templateRequired: false,
    confidence: 0.9,
  },
];

const prep = buildDocumentPreparation({
  documents,
  profileCopyFields: [
    { label: "기업명", value: "노트엔", source: "company_profile" },
    { label: "업종/분야", value: "AI SaaS", source: "company_profile" },
  ],
  planDraftPrompts: [{
    title: "지원 동기",
    prompt: "지원 동기를 작성하세요.",
    evidence: ["AI SaaS"],
  }],
  company: {
    id: "company-1",
    is_preliminary: false,
    name: "노트엔",
    industries: ["AI SaaS"],
    confidence: {},
  },
});

assert.equal(prep.documentGroups.some((group) => group.preparationType === "write"), true);
assert.equal(prep.draftableDocuments.length, 2);
assert.equal(prep.issuableDocuments.length, 1);
assert.equal(prep.attachableDocuments.length, 1);
assert.equal(prep.draftCoverage.totalDocuments, 5);
assert.equal(prep.draftCoverage.draftableCount, 2);
assert.equal(prep.draftCoverage.withAttachmentContextCount, 1);
assert.equal(prep.draftableDocuments.some((document) => document.category === "consent_or_pledge"), false);
assert.equal(prep.missingProfileFields.some((field) => field.fieldKey === "business.product_summary"), true);

const grant: GrantDetail = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "bizinfo",
  sourceId: "PBLN_TEST",
  title: "AI 서비스 사업화 지원사업",
  agency: "테스트기관",
  supportAmount: {
    min: null,
    max: 50_000_000,
    unit: "KRW",
    per: "기업",
    label: null,
  },
  benefits: [],
  status: "open",
};
const businessPlan = prep.draftableDocuments.find((document) => document.category === "business_plan");
assert.ok(businessPlan);
const draft = generateDocumentDraftContent({
  grant,
  document: businessPlan,
  profileCopyFields: prep.profileCopyFields,
  missingProfileFields: prep.missingProfileFields,
  answers: {
    "제품/서비스 설명": "지원사업 탐색과 신청서 작성을 자동화하는 SaaS입니다.",
    "이번 지원으로 달성할 목표": "첨부 양식 자동채움 정확도를 높이고 초기 고객을 확보하겠습니다.",
  },
});
assert.equal(draft.status, "needs_input");
assert.equal(draft.draftMarkdown.includes("AI 서비스 사업화 지원사업"), true);
assert.equal(draft.draftMarkdown.includes("지원사업 탐색과 신청서 작성을 자동화"), true);
assert.equal(draft.autofill.usedProfileFields.includes("기업명"), true);
assert.equal(draft.warnings.some((warning) => warning.includes("사용자 검토")), true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "document_preparation_groups",
    "draftable_document_filter",
    "missing_field_questions",
    "deterministic_draft_generation",
    "autofill_profile_fields",
  ],
  draftableCount: prep.draftableDocuments.length,
  missingFieldCount: prep.missingProfileFields.length,
}, null, 2));
