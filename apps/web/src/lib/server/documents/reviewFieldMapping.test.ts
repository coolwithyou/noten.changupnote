import assert from "node:assert/strict";
import {
  resolveReviewFieldFillPlan,
  reviewFieldsToReconciled,
  type ReviewLabelField,
} from "./reviewFieldMapping";

const expectedPlans: Array<[string, string | null, string]> = [
  ["company_name", "name", "copy"],
  ["biz_reg_no", "biz_no", "copy"],
  ["ceo_name", "representative_name", "copy"],
  ["address", "region", "copy"],
  ["industry", "industries", "summarize"],
  ["biz_field", "industries", "summarize"],
  ["company_size", "size", "copy"],
  ["employee_count", "employees", "copy"],
  ["revenue", "revenue", "copy"],
  ["exec_plan", null, "generate"],
  ["expected_effect", null, "generate"],
];

for (const [key, mappedCompanyField, fillStrategy] of expectedPlans) {
  assert.deepEqual(
    resolveReviewFieldFillPlan({ key, label: key, type: "text", manual: false }),
    { mappedCompanyField, fillStrategy },
    `${key} fill plan`,
  );
}

for (const field of [
  { key: "resident_reg_no", label: "주민등록번호(대표자)", type: "text", manual: true },
  { key: "member1_reg_no", label: "팀원1 주민등록번호", type: "text", manual: true },
  { key: "rep_signature", label: "신청인 서명", type: "signature", manual: false },
  { key: "attachment_files", label: "첨부서류", type: "file", manual: false },
  { key: "sms_consent", label: "문자 수신 동의", type: "checkbox", manual: false },
] satisfies ReviewLabelField[]) {
  assert.deepEqual(
    resolveReviewFieldFillPlan(field),
    { mappedCompanyField: null, fillStrategy: "manual" },
    `${field.key} must stay manual`,
  );
}

for (const field of [
  { key: "resident_address", label: "주소(대표자)", type: "text", manual: false },
  { key: "member1_address", label: "팀원1 주소", type: "text", manual: false },
  { key: "founded_date", label: "설립일", type: "date", manual: false },
] satisfies ReviewLabelField[]) {
  assert.deepEqual(
    resolveReviewFieldFillPlan(field),
    { mappedCompanyField: null, fillStrategy: "ask_user" },
    `${field.key} must not be mapped by label similarity`,
  );
}

const reconciled = reviewFieldsToReconciled([
  { key: "company_name", label: "기업명", type: "text", manual: false },
  { key: "company_name", label: "상호명", type: "text", manual: false },
  { key: "unknown_field", label: "추가 확인", type: "text", manual: false },
]);
assert.equal(reconciled[0]?.fieldKey, "company_name");
assert.equal(reconciled[0]?.mappedCompanyField, "name");
assert.equal(reconciled[0]?.fillStrategy, "copy");
assert.equal(reconciled[1]?.fieldKey, "company_name-2");
assert.equal(reconciled[1]?.mappedCompanyField, "name");
assert.equal(reconciled[2]?.fillStrategy, "ask_user");

console.log("review field fill-plan tests passed");
