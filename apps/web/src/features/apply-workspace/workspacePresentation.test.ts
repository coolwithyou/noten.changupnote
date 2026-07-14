import assert from "node:assert/strict";
import { buildInstitutionContact, contactPhoneHref, workspaceFieldState } from "./workspacePresentation";

assert.equal(workspaceFieldState(undefined), "empty");
assert.equal(workspaceFieldState({ value: "", status: "dismissed", source: "user", updatedAt: "now" }), "empty");
assert.equal(workspaceFieldState({ value: "제안", status: "suggested", source: "llm", updatedAt: "now" }), "reviewing");
assert.equal(workspaceFieldState({ value: "확정", status: "accepted", source: "profile", updatedAt: "now" }), "filled");
assert.equal(workspaceFieldState({ value: "수정", status: "edited", source: "user", updatedAt: "now" }), "filled");

assert.deepEqual(
  buildInstitutionContact({
    agency: "창업진흥원",
    applyMethod: "문의 02-1234-5678 / apply@example.or.kr",
    deepLink: "https://example.or.kr/grants/1",
  }),
  {
    name: "창업진흥원",
    phone: "02-1234-5678",
    email: "apply@example.or.kr",
    sourceUrl: "https://example.or.kr/grants/1",
  },
);
assert.equal(
  buildInstitutionContact({ agency: "창업진흥원", applyMethod: "온라인 접수", deepLink: null }),
  null,
);
assert.equal(contactPhoneHref("02-1234-5678"), "tel:0212345678");
assert.equal(
  buildInstitutionContact({ agency: "수출바우처 사무국", applyMethod: "문의 1600-7119", deepLink: null })?.phone,
  "1600-7119",
);

console.log("apply-workspace presentation tests passed");
