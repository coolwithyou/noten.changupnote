import assert from "node:assert/strict";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import {
  applicationProfileValue,
  buildApplicationProfileAutofillPlan,
  resolveApplicationProfileKey,
  type ApplicationAutofillProfile,
} from "./applicationProfileAutofill";

const profile: ApplicationAutofillProfile = {
  personal: {
    fullName: "홍길동",
    applicationEmail: "apply@example.com",
    phone: "010-1234-5678",
    postalCode: "06236",
    addressLine1: "서울특별시 강남구 테헤란로 1",
    addressLine2: "101호",
  },
  company: {
    name: "창업노트 주식회사",
    representativeName: "홍길동",
    businessNumber: "1234567891",
    businessNumberVerified: false,
    applicationEmail: "company@example.com",
    phone: "02-1234-5678",
    postalCode: "06236",
    addressLine1: "서울특별시 강남구 테헤란로 2",
    addressLine2: null,
  },
  updatedAt: "2026-08-21T00:00:00.000Z",
};

assert.equal(resolveApplicationProfileKey(field({ mappedCompanyField: "name" })), "company_name");
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "biz_reg_no" })), "company_business_number");
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "신청인_이메일", label: "신청인 이메일" })), "applicant_email");
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "회사_전화", label: "회사 전화번호" })), "company_phone");
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "address", label: "사업장 소재지" })), "company_address");
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "자택_주소", label: "대표자 자택 주소" })), "applicant_address");
assert.equal(
  resolveApplicationProfileKey(field({ mappedCompanyField: "name", label: "외주 수행기관 회사명" })),
  null,
  "제3자 회사명은 mappedCompanyField가 있어도 신청 회사 정보로 채우지 않는다",
);
assert.equal(resolveApplicationProfileKey(field({ fieldKey: "resident", label: "주민등록번호" })), null);

assert.equal(applicationProfileValue(profile, "company_business_number"), "123-45-67891");
assert.equal(applicationProfileValue(profile, "applicant_address"), "서울특별시 강남구 테헤란로 1 101호");

const fields = [
  field({ fieldId: "company", fieldKey: "company_name", label: "기업명", mappedCompanyField: "name" }),
  field({ fieldId: "guide", fieldKey: "company_phone", label: "회사 전화번호" }),
  field({ fieldId: "filled", fieldKey: "applicant_email", label: "신청인 이메일" }),
  field({ fieldId: "missing", fieldKey: "company_postal_code", label: "회사 우편번호" }),
  field({ fieldId: "ambiguous", fieldKey: "ceo_name", label: "대표자명" }),
  field({ fieldId: "sensitive", fieldKey: "resident", label: "주민등록번호" }),
];

const plan = buildApplicationProfileAutofillPlan({
  fields,
  profile: {
    ...profile,
    company: { ...profile.company, postalCode: null },
  },
  bindings: [
    { fieldId: "company", status: "unique", beforeText: "" },
    { fieldId: "guide", status: "unique", beforeText: "※ 전화번호를 기재하세요" },
    { fieldId: "filled", status: "unique", beforeText: "saved@example.com" },
    { fieldId: "missing", status: "unique", beforeText: "" },
    { fieldId: "ambiguous", status: "ambiguous" },
    { fieldId: "sensitive", status: "unique", beforeText: "" },
  ],
});

assert.deepEqual(plan.ready.map((item) => item.fieldId), ["company", "guide"]);
assert.equal(plan.items.find((item) => item.fieldId === "guide")?.value, "02-1234-5678");
assert.equal(plan.items.find((item) => item.fieldId === "filled")?.state, "already_filled");
assert.deepEqual(plan.missingProfileKeys, ["company_postal_code"]);
assert.equal(plan.items.find((item) => item.fieldId === "ambiguous")?.state, "blocked");
assert.equal(plan.items.find((item) => item.fieldId === "sensitive")?.state, "blocked");

function field(overrides: Partial<ConnectedDocumentField>): ConnectedDocumentField {
  return {
    fieldId: overrides.fieldId ?? "field-1",
    fieldKey: overrides.fieldKey ?? "unmapped",
    label: overrides.label ?? "알 수 없는 항목",
    section: overrides.section ?? "신청서",
    fieldType: overrides.fieldType ?? "text",
    required: overrides.required ?? false,
    sourceSpan: overrides.sourceSpan ?? null,
    mappedCompanyField: overrides.mappedCompanyField ?? null,
    fillStrategy: overrides.fillStrategy ?? "ask_user",
    position: overrides.position ?? null,
    visualEvidence: overrides.visualEvidence ?? null,
  };
}

console.log("application profile autofill tests passed");
