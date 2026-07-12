import assert from "node:assert/strict";
import { checkKiprisApplicant, KiprisApplicantError, parseKiprisApplicant } from "./check-applicant.js";

const fixture = `
<response>
  <header><resultCode></resultCode><resultMsg></resultMsg></header>
  <body><items><corpBsApplicantInfo>
    <ApplicantNumber>119980018012</ApplicantNumber>
    <ApplicantName>삼성카드 주식회사</ApplicantName>
    <CorporationNumber>110111-0346901</CorporationNumber>
    <BusinessRegistrationNumber>202-81-45602</BusinessRegistrationNumber>
  </corpBsApplicantInfo></items></body>
</response>`;

assert.deepEqual(parseKiprisApplicant(fixture), {
  applicantNumber: "119980018012",
  applicantName: "삼성카드 주식회사",
  corporationNumber: "110111-0346901",
  businessRegistrationNumber: "202-81-45602",
});
assert.equal(parseKiprisApplicant("<response><header/><body><items/></body></response>"), null);
assert.throws(
  () => parseKiprisApplicant("<response><header><resultCode>12</resultCode><resultMsg>INVALID</resultMsg></header></response>"),
  KiprisApplicantError,
);

let requestedUrl = "";
const match = await checkKiprisApplicant({
  accessKey: "test-key",
  bizNo: "2028145602",
  fetchImpl: async (input) => {
    requestedUrl = String(input);
    return new Response(fixture, { status: 200, headers: { "content-type": "application/xml" } });
  },
});
assert.equal(match?.applicantNumber, "119980018012");
const url = new URL(requestedUrl);
assert.equal(url.searchParams.get("BusinessRegistrationNumber"), "202-81-45602");
assert.equal(url.searchParams.get("accessKey"), "test-key");

console.log("kipris/check-applicant.test.ts: all assertions passed");
