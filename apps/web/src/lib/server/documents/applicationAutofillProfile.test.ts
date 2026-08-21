import assert from "node:assert/strict";
import type { ApplicationAutofillProfileInput } from "@/lib/documents/applicationProfileAutofill";
import {
  ApplicationAutofillProfileError,
  normalizeApplicationAutofillProfileInput,
} from "./applicationAutofillProfile";

const valid = input();
const normalized = normalizeApplicationAutofillProfileInput(valid);
assert.equal(normalized.personal.fullName, "홍 길동");
assert.equal(normalized.personal.applicationEmail, "user@example.com");
assert.equal(normalized.company.businessNumber, "1234567891");
assert.equal(normalized.company.addressLine2, null);

assert.throws(
  () => normalizeApplicationAutofillProfileInput(input({ company: { businessNumber: "123-45-67890" } })),
  (error) => error instanceof ApplicationAutofillProfileError
    && error.code === "invalid_business_number_checksum"
    && error.field === "company.businessNumber",
);
assert.throws(
  () => normalizeApplicationAutofillProfileInput(input({ personal: { applicationEmail: "invalid" } })),
  (error) => error instanceof ApplicationAutofillProfileError && error.code === "invalid_email",
);
assert.throws(
  () => normalizeApplicationAutofillProfileInput(input({ company: { phone: "전화주세요" } })),
  (error) => error instanceof ApplicationAutofillProfileError && error.code === "invalid_phone",
);

function input(overrides: {
  personal?: Partial<ApplicationAutofillProfileInput["personal"]>;
  company?: Partial<ApplicationAutofillProfileInput["company"]>;
} = {}): ApplicationAutofillProfileInput {
  return {
    personal: {
      fullName: "  홍   길동 ",
      applicationEmail: "USER@EXAMPLE.COM",
      phone: "010-1234-5678",
      postalCode: "06236",
      addressLine1: "서울 강남구",
      addressLine2: "101호",
      ...overrides.personal,
    },
    company: {
      name: "창업노트 주식회사",
      representativeName: "홍길동",
      businessNumber: "123-45-67891",
      applicationEmail: "company@example.com",
      phone: "02-1234-5678",
      postalCode: "06236",
      addressLine1: "서울 강남구",
      addressLine2: "",
      ...overrides.company,
    },
  };
}

console.log("application autofill profile validation tests passed");
