import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CompanyProfile } from "@cunote/contracts";
import type { KStartupApiResponse } from "../src/index.js";
import { matchGrantCriteria, normalizeKStartupPayload } from "../src/index.js";

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
