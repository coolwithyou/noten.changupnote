import assert from "node:assert/strict";
import {
  buildCompanyProfileFromPopbill,
  calculateBizAgeMonths,
  matchGrantCriteria,
  maskCorpNum,
  resolveCompanySize,
  resolveRegionFromAddress,
  sanitizeCorpNum,
} from "../src/index.js";

assert.equal(sanitizeCorpNum("123-45-67890"), "1234567890");
assert.equal(maskCorpNum("1234567890"), "123-**-67***");
assert.equal(resolveCompanySize("30"), "중소기업");
assert.equal(resolveCompanySize("21"), "중견기업");
assert.deepEqual(resolveRegionFromAddress("경기도 성남시 분당구"), { code: "41", label: "경기" });
assert.equal(calculateBizAgeMonths("20240115", new Date("2026-06-26T00:00:00.000Z")), 29);

const enriched = buildCompanyProfileFromPopbill({
  result: 100,
  resultMessage: "성공",
  checkDT: "20260626101802",
  corpNum: "1234567890",
  corpName: "테스트 주식회사",
  CEOName: "홍길동",
  corpScaleCode: "30",
  industryCode: "J62",
  bizClass: "정보통신업",
  bizType: "소프트웨어 개발",
  establishDate: "20240115",
  addr: "경기도 성남시 분당구 판교로",
  closeDownState: 1,
  closeDownTaxType: 10,
}, {
  asOf: new Date("2026-06-26T00:00:00.000Z"),
});

assert.equal(enriched.profile.name, "테스트 주식회사");
assert.deepEqual(enriched.profile.region, { code: "41", label: "경기" });
assert.equal(enriched.profile.biz_age_months, 29);
assert.equal(enriched.profile.size, "중소기업");
// industries = 라벨만(bizClass/bizType), 코드는 industry_codes로 분리
assert.deepEqual(enriched.profile.industries, ["정보통신업", "소프트웨어 개발"]);
assert.deepEqual(enriched.profile.industry_codes, ["J62", "62", "J"]);
assert.equal(enriched.profile.confidence?.industry, 0.7);
assert.equal(enriched.profile.business_status?.active, true);
assert.equal(enriched.facts.masked_biz_no, "123-**-67***");
assert.equal(enriched.facts.has_region, true);
assert.equal(enriched.facts.has_biz_age, true);
assert.equal(enriched.facts.has_size, true);
assert.equal(enriched.facts.has_industry, true);

const statusMatch = matchGrantCriteria([{
  id: "bizinfo:test:business-status",
  dimension: "business_status",
  operator: "not_in",
  kind: "exclusion",
  value: { statuses: ["closed"], labels: ["휴폐업"] },
  confidence: 0.9,
  source_span: "휴폐업 중인 기업은 신청 제외",
}], enriched.profile);
assert.equal(statusMatch.eligibility, "eligible");
assert.equal(statusMatch.rule_trace[0]?.result, "pass");

console.log(JSON.stringify({
  ok: true,
  checked: ["corp_num", "region", "biz_age", "size", "industry", "business_status"],
  sample_profile: {
    region: enriched.profile.region,
    biz_age_months: enriched.profile.biz_age_months,
    size: enriched.profile.size,
    industries_count: enriched.profile.industries?.length ?? 0,
  },
}, null, 2));
