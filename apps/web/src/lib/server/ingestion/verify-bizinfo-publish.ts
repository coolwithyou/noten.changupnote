import assert from "node:assert/strict";
import { matchNormalizedGrant } from "@cunote/core";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { planBizInfoPublication } from "./bizinfoPublisher";

const entries = buildBizInfoSampleEntries({
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});
const plan = planBizInfoPublication(entries);

assert.equal(plan.source, "bizinfo");
assert.equal(plan.rawCount, 1);
assert.equal(plan.grantCount, 1);
assert.equal(plan.criteriaCount, 3);
assert.equal(plan.rawHashes.length, 1);
assert.match(plan.rawHashes[0] ?? "", /^[a-f0-9]{64}$/);
assert.equal(plan.extractionReadinessCounts.partial, 1, "unarchived source attachment keeps extraction partial");
assert.equal(plan.extractionWarningCounts.attachment_fetch_incomplete, 1);

const first = entries[0];
assert.ok(first, "sample entry should exist");
assert.equal(first.grant.source, "bizinfo");
assert.deepEqual(first.grant.f_regions, ["41"]);
assert.ok(first.grant.f_industries.includes("ICT"));
assert.deepEqual(
  first.grant.required_documents?.map((document) => document.name),
  ["신청서", "사업자등록증", "재무제표"],
);
assert.deepEqual(first.raw.attachments, [{
  filename: "사업계획서.hwp",
  url: "https://www.bizinfo.go.kr/fileDownload.do?atchFileId=PBLN_SAMPLE",
}]);
assert.equal(
  matchNormalizedGrant(first, {
    region: { code: "41", label: "경기" },
    industries: ["ICT", "SW"],
    size: "중소",
  }).eligibility,
  "eligible",
);
assert.equal(
  matchNormalizedGrant(first, {
    region: { code: "41", label: "경기" },
    industries: ["ICT", "SW"],
    size: "중소",
  }).review_gate?.tier,
  "needs_core_review",
  "attachment-incomplete grant must not be recommendable",
);

console.log(JSON.stringify({
  ok: true,
  checked: ["raw_hash", "raw_attachments", "grant_projection", "required_documents", "criteria_match", "extraction_gate"],
  ...plan,
}, null, 2));
