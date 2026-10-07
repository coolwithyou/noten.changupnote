import assert from "node:assert/strict";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import {
  acceptAutomaticProfileAutofillAnswers,
  applicationProfileValue,
  buildAutomaticProfileAutofillEntries,
  buildApplicationProfileAutofillPlan,
  resolveApplicationProfileKey,
  undoAutomaticProfileAutofillAnswers,
  type ApplicationAutofillProfile,
} from "./applicationProfileAutofill";
import { selectKakaoPostalAddress } from "@/lib/postcode/kakaoPostcode";

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

// 실제 원문의 broad alias가 저장된 주소·국문 상호·사업자번호의 의미를 바꾸지 못한다.
const unsupportedAliases = [
  field({ fieldId: "website", fieldKey: "address", label: "홈페이지 주소", mappedCompanyField: "region" }),
  field({ fieldId: "web-url", fieldKey: "company_address", label: "회사 웹사이트 URL", mappedCompanyField: "name" }),
  field({ fieldId: "web-en", fieldKey: "address", label: "Website address", mappedCompanyField: "region" }),
  field({ fieldId: "english-company", fieldKey: "company_name", label: "기업명(영문)", mappedCompanyField: "name" }),
  field({ fieldId: "english-placeholder", fieldKey: "company_name-2", label: "(영문)", mappedCompanyField: "name" }),
  field({ fieldId: "english-company-en", fieldKey: "company_name", label: "Company name (English)", mappedCompanyField: "name" }),
  field({ fieldId: "corporate-number", fieldKey: "biz_reg_no", label: "법인등록번호", mappedCompanyField: "biz_no" }),
  field({ fieldId: "mixed-number", fieldKey: "biz_reg_no", label: "법인등록번호\n(사업자등록번호)", mappedCompanyField: "biz_no" }),
];
const supportedIdentities = [
  field({ fieldId: "korean-company", fieldKey: "company_name", label: "기업명(국문)", mappedCompanyField: "name" }),
  field({ fieldId: "postal-address", fieldKey: "address", label: "사업장 주소", mappedCompanyField: "region" }),
  field({ fieldId: "business-number", fieldKey: "biz_reg_no", label: "사업자등록번호", mappedCompanyField: "biz_no" }),
];
for (const candidate of unsupportedAliases) {
  assert.equal(resolveApplicationProfileKey(candidate), null, `${candidate.label}: mapped/canonical alias보다 의미 보호를 먼저 적용`);
}
assert.deepEqual(supportedIdentities.map(resolveApplicationProfileKey), ["company_name", "company_address", "company_business_number"]);
const aliasFields = [...unsupportedAliases, ...supportedIdentities];
const aliasBindings = aliasFields.map(candidate => ({ fieldId: candidate.fieldId, status: "unique" as const,
  targetKind: "table_cell_text" as const, beforeText: "" }));
const aliasPlan = buildApplicationProfileAutofillPlan({ fields: aliasFields, profile, bindings: aliasBindings });
assert.deepEqual(aliasPlan.ready.map(item => item.fieldId), supportedIdentities.map(candidate => candidate.fieldId));
assert.equal(aliasPlan.ready.find(item => item.fieldId === "postal-address")?.value, profile.company.addressLine1);
assert.equal(aliasPlan.ready.find(item => item.fieldId === "business-number")?.value, "123-45-67891");
for (const candidate of unsupportedAliases) {
  assert.equal(aliasPlan.items.find(item => item.fieldId === candidate.fieldId)?.state, "blocked");
}
const aliasAnswers = Object.fromEntries(aliasFields.map(candidate => [candidate.label, {
  fieldId: candidate.fieldId, value: "이미 저장된 broad profile seed", status: "suggested" as const, source: "profile" as const, updatedAt: "seeded",
}]));
assert.deepEqual(buildAutomaticProfileAutofillEntries({ fields: aliasFields, answers: aliasAnswers, bindings: aliasBindings })
  .map(entry => entry.fieldId), supportedIdentities.map(candidate => candidate.fieldId), "기존 broad seed도 진입 자동입력 보호를 우회하지 못한다");
const employee = field({ fieldId: "employees", fieldKey: "employee_count", label: "고용 인원", mappedCompanyField: "employees" });
assert.equal(buildAutomaticProfileAutofillEntries({ fields: [employee], answers: {
  [employee.label]: { fieldId: employee.fieldId, value: "5명", status: "suggested", source: "profile", updatedAt: "seeded" },
}, bindings: [{ fieldId: employee.fieldId, status: "unique", targetKind: "table_cell_text", beforeText: "" }] }).length, 1,
"identity profile key 밖의 기존 일반 회사속성 seed를 함께 차단하지 않는다");

assert.equal(applicationProfileValue(profile, "company_business_number"), "123-45-67891");
assert.equal(applicationProfileValue(profile, "applicant_address"), "서울특별시 강남구 테헤란로 1 101호");

assert.deepEqual(selectKakaoPostalAddress({
  zonecode: "06236",
  address: "서울 강남구 테헤란로 1",
  userSelectedType: "R",
  roadAddress: "서울 강남구 테헤란로 1",
  jibunAddress: "서울 강남구 역삼동 1",
  bname: "역삼동",
  buildingName: "창업빌딩",
  apartment: "Y",
}), {
  postalCode: "06236",
  address: "서울 강남구 테헤란로 1 (역삼동, 창업빌딩)",
});
assert.deepEqual(selectKakaoPostalAddress({
  zonecode: "12345",
  address: "강원 철원군 갈말읍 1",
  userSelectedType: "J",
  roadAddress: "",
  jibunAddress: "강원 철원군 갈말읍 1",
  bname: "갈말읍",
  buildingName: "",
  apartment: "N",
}), {
  postalCode: "12345",
  address: "강원 철원군 갈말읍 1",
});
assert.equal(selectKakaoPostalAddress({
  zonecode: "",
  address: "",
  userSelectedType: "R",
  roadAddress: "",
  jibunAddress: "",
  bname: "",
  buildingName: "",
  apartment: "N",
}), null);

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

const automaticAnswers = {
  기업명: {
    value: "창업노트 주식회사",
    status: "suggested" as const,
    source: "profile" as const,
    fieldId: "company",
    updatedAt: "seeded",
  },
  "회사 전화번호": {
    value: "02-1234-5678",
    status: "edited" as const,
    source: "user" as const,
    fieldId: "guide",
    updatedAt: "edited",
  },
};
const automaticEntries = buildAutomaticProfileAutofillEntries({
  fields,
  answers: automaticAnswers,
  bindings: [
    { fieldId: "company", status: "unique", targetKind: "table_cell_text", beforeText: "" },
    { fieldId: "guide", status: "unique", targetKind: "table_cell_text", beforeText: "" },
  ],
});
assert.deepEqual(automaticEntries, [{ fieldId: "company", label: "기업명", value: "창업노트 주식회사" }]);
assert.equal(
  buildAutomaticProfileAutofillEntries({
    fields,
    answers: automaticAnswers,
    bindings: [{ fieldId: "company", status: "unique", targetKind: "table_cell_text", beforeText: "※ 회사명" }],
  }).length,
  0,
  "자동 입력은 안내문도 교체하지 않고 완전히 빈 표 셀만 사용한다",
);
assert.equal(
  buildAutomaticProfileAutofillEntries({
    fields: [fields[0]!, { ...fields[0]!, fieldId: "company-copy" }],
    answers: automaticAnswers,
    bindings: [{ fieldId: "company", status: "unique", targetKind: "table_cell_text", beforeText: "" }],
  }).length,
  0,
  "같은 라벨이 둘 이상이면 한 위치를 임의 선택하지 않는다",
);
const acceptedAutomatic = acceptAutomaticProfileAutofillAnswers({
  current: automaticAnswers,
  entries: automaticEntries,
  revisionId: "revision-auto",
  at: "accepted",
});
assert.equal(acceptedAutomatic.기업명?.status, "accepted");
assert.equal(acceptedAutomatic.기업명?.materializedRevisionId, "revision-auto");
assert.equal(acceptedAutomatic["회사 전화번호"]?.status, "edited");
const undoneAutomatic = undoAutomaticProfileAutofillAnswers({
  current: acceptedAutomatic,
  entries: automaticEntries,
  appliedRevisionId: "revision-auto",
  at: "undone",
});
assert.equal(undoneAutomatic.기업명?.status, "dismissed");
assert.equal(undoneAutomatic.기업명?.materializedRevisionId, undefined);
assert.equal(buildAutomaticProfileAutofillEntries({
  fields,
  answers: undoneAutomatic,
  bindings: [{ fieldId: "company", status: "unique", targetKind: "table_cell_text", beforeText: "" }],
}).length, 0, "Undo를 저장한 뒤 새 화면에서 다시 열어도 자동 입력 후보로 돌아오지 않는다");

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
