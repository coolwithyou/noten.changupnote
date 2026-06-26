import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  BizAgeCriterionValue,
  CompanyProfile,
  FounderAgeCriterionValue,
  RegionCriterionValue,
} from "@cunote/contracts";
import type { KStartupApiResponse } from "../src/index.js";
import {
  assertKStartupApiResponse,
  buildKStartupUrl,
  matchGrantCriteria,
  normalizeKStartupPayload,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const normalized = normalizeKStartupPayload(fixture, {
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});

assert.ok(normalized.length > 0, "K-Startup sample must produce normalized grants");
assert.ok(
  normalized.some((item) => item.criteria.length > 0),
  "at least one sample grant must produce grant_criteria",
);
assert.equal(normalized.length, 20, "sample fixture should keep 20 rows");

const company: CompanyProfile = {
  id: "demo-company",
  name: "(가칭)테크스타트",
  region: { code: "41", label: "경기" },
  biz_age_months: 26,
  founder_age: 35,
  is_preliminary: false,
  industries: ["ICT", "SW"],
  size: "중소",
  confidence: {
    region: 0.95,
    biz_age: 0.9,
    founder_age: 0.9,
    industry: 0.65,
    size: 0.65,
  },
};

const openItems = normalized.filter((item) => item.grant.status === "open");
const matches = openItems.map((item) => ({
  grant: item.grant,
  criteria: item.criteria,
  match: matchGrantCriteria(item.criteria, company),
}));

assert.ok(matches.length > 0, "sample must contain open grants for the fixed asOf date");
assert.ok(
  matches.every((item) => ["eligible", "conditional", "ineligible"].includes(item.match.eligibility)),
  "each match must have a supported eligibility",
);
assert.ok(
  matches.every((item) => item.match.rule_trace.length > 0),
  "each match must produce a rule_trace",
);
assertKnownSampleRegressions();
assertFetchHelpers();

const counts = matches.reduce<Record<string, number>>((acc, item) => {
  acc[item.match.eligibility] = (acc[item.match.eligibility] ?? 0) + 1;
  return acc;
}, {});

const examples = matches.slice(0, 5).map((item) => ({
  source_id: item.grant.source_id,
  title: item.grant.title,
  status: item.grant.status,
  criteria_count: item.criteria.length,
  eligibility: item.match.eligibility,
  fit_score: item.match.fit_score,
  unknown_fields: item.match.unknown_fields,
  first_trace: item.match.rule_trace[0]?.message,
}));

console.log(JSON.stringify({
  normalized_count: normalized.length,
  open_count: openItems.length,
  match_counts: counts,
  first_grant: {
    source_id: normalized[0]?.grant.source_id,
    title: normalized[0]?.grant.title,
    criteria: normalized[0]?.criteria.map((criterion) => ({
      dimension: criterion.dimension,
      operator: criterion.operator,
      kind: criterion.kind,
      value: criterion.value,
    })),
  },
  examples,
}, null, 2));

function assertKnownSampleRegressions() {
  const bySourceId = new Map(normalized.map((item) => [item.grant.source_id, item]));

  const techBridge = bySourceId.get("178246");
  assert.ok(techBridge, "fixture must include Startup Tech Bridge");
  const techBridgeRegion = techBridge.criteria.find((criterion) => criterion.dimension === "region");
  assert.deepEqual(
    (techBridgeRegion?.value as RegionCriterionValue | undefined)?.regions,
    ["41"],
    "Tech Bridge should normalize 경기 to region code 41",
  );
  const techBridgeBizAge = techBridge.criteria.find((criterion) => criterion.dimension === "biz_age");
  assert.equal(
    (techBridgeBizAge?.value as BizAgeCriterionValue | undefined)?.max_months,
    84,
    "Tech Bridge should normalize 7년미만 to 84 months",
  );
  assert.equal(
    (techBridgeBizAge?.value as BizAgeCriterionValue | undefined)?.include_preliminary,
    true,
    "Tech Bridge should keep preliminary-founder allowance",
  );
  assert.equal(
    matchGrantCriteria(techBridge.criteria, company).eligibility,
    "eligible",
    "Tech Bridge should remain eligible for the demo company",
  );

  const digitalGlobal = bySourceId.get("178245");
  assert.ok(digitalGlobal, "fixture must include Digital Global program");
  const metroExclusion = digitalGlobal.criteria.find(
    (criterion) => criterion.dimension === "region" && criterion.kind === "exclusion",
  );
  assert.deepEqual(
    (metroExclusion?.value as RegionCriterionValue | undefined)?.regions,
    ["11", "28", "41"],
    "수도권 제외 should normalize to Seoul/Incheon/Gyeonggi exclusion",
  );
  assert.equal(
    matchGrantCriteria(digitalGlobal.criteria, company).eligibility,
    "ineligible",
    "수도권 제외 program should reject the Gyeonggi demo company",
  );

  const youthProgram = bySourceId.get("178223");
  assert.ok(youthProgram, "fixture must include youth program");
  const founderAge = youthProgram.criteria.find((criterion) => criterion.dimension === "founder_age");
  assert.equal(
    (founderAge?.value as FounderAgeCriterionValue | undefined)?.youth_only,
    true,
    "single 20~39 bracket should be preserved as youth-only founder age criteria",
  );

  const conditional = matches.find((item) => item.match.eligibility === "conditional");
  assert.ok(conditional, "fixture should include at least one conditional match");
  assert.ok(conditional.match.next_question, "conditional match should suggest a next question");
}

function assertFetchHelpers() {
  const encodedUrl = buildKStartupUrl("https://example.test/api", "abc/def==", 2, 10);
  assert.equal(
    encodedUrl,
    "https://example.test/api?serviceKey=abc%2Fdef%3D%3D&page=2&perPage=10&returnType=json",
  );
  const alreadyEncodedUrl = buildKStartupUrl("https://example.test/api", "abc%2Fdef%3D%3D", 1, 5);
  assert.equal(
    alreadyEncodedUrl,
    "https://example.test/api?serviceKey=abc%2Fdef%3D%3D&page=1&perPage=5&returnType=json",
  );
  assert.throws(
    () => assertKStartupApiResponse({ data: [{ biz_pbanc_nm: "missing id" }] }),
    /missing pbanc_sn/,
  );
}
