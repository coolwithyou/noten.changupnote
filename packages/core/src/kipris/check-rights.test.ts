import assert from "node:assert/strict";
import { buildKiprisRightUrl, checkKiprisRights, parseKiprisRightSummary } from "./check-rights.js";

const patentXml = `<response><header><resultCode>00</resultCode></header><body><items>
  <PatentUtilityInfo><OpeningNumber>10-2026-1</OpeningNumber><RegistrationNumber>10-1</RegistrationNumber><RegistrationStatus>등록</RegistrationStatus></PatentUtilityInfo>
  <PatentUtilityInfo><OpeningNumber>10-2026-2</OpeningNumber><RegistrationStatus>소멸</RegistrationStatus></PatentUtilityInfo>
  <totalSearchCount>2</totalSearchCount>
</items></body></response>`;
const designXml = `<response><body><items><totalCount>1</totalCount>
  <DesignInfo><openNumber>30-1</openNumber><registrationNumber>30-2</registrationNumber><applicationStatus>등록</applicationStatus></DesignInfo>
</items></body></response>`;
const trademarkXml = `<response><body><items><TotalSearchCount>501</TotalSearchCount>
  <TradeMarkInfo><PublicNumber>40-1</PublicNumber><RegistrationNumber>40-2</RegistrationNumber><ApplicationStatus>등록</ApplicationStatus></TradeMarkInfo>
</items></body></response>`;

assert.deepEqual(parseKiprisRightSummary(patentXml, "patent_utility"), {
  kind: "patent_utility",
  totalCount: 2,
  appliedCount: 2,
  fetchedCount: 2,
  publishedCount: 2,
  registeredCount: 1,
  extinguishedCount: 1,
  truncated: false,
});
assert.equal(parseKiprisRightSummary(designXml, "design").registeredCount, 1);
assert.equal(parseKiprisRightSummary(trademarkXml, "trademark").truncated, true);

const patentUrl = new URL(buildKiprisRightUrl("patent_utility", "test-key", "120240855581"));
assert.equal(patentUrl.searchParams.get("applicant"), "120240855581");
assert.equal(patentUrl.searchParams.get("docsCount"), "500");
assert.equal(patentUrl.searchParams.get("patent"), "true");

const fixtures = new Map([
  ["patUtiModInfoSearchSevice", patentXml],
  ["designInfoSearchService", designXml],
  ["trademarkInfoSearchService", trademarkXml],
]);
const calls: string[] = [];
const summary = await checkKiprisRights({
  accessKey: "test-key",
  applicantNumber: "120240855581",
  fetchImpl: async (input) => {
    const url = String(input);
    calls.push(url);
    const fixture = [...fixtures].find(([fragment]) => url.includes(fragment))?.[1];
    return new Response(fixture ?? "", { status: fixture ? 200 : 404 });
  },
});
assert.equal(calls.length, 3);
assert.equal(summary.totalCount, 504);
assert.equal(summary.truncated, true);

console.log("kipris/check-rights.test.ts: all assertions passed");
