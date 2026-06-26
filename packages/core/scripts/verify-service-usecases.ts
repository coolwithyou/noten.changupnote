import assert from "node:assert/strict";
import type {
  CompanyProfile,
  Grant,
  GrantCriterion,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  buildApplySheet,
  buildDashboard,
  matchGrantCriteria,
} from "../src/index.js";

const asOf = new Date("2026-06-01T00:00:00.000Z");
const company: CompanyProfile = {
  name: "업력 로드맵 테스트 기업",
  region: { code: "41", label: "경기" },
  biz_age_months: 10,
  industries: ["ICT"],
  size: "중소",
  confidence: {},
};

const soonGrant = normalizedGrant("soon-biz-age", "업력 1년 이상 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "biz_age",
    operator: "gte",
    kind: "required",
    value: { min_months: 12, include_preliminary: false, labels: ["1년 이상"] },
    confidence: 0.9,
  },
]);

const tooOldGrant = normalizedGrant("too-old-biz-age", "업력 6개월 이내 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { max_months: 6, include_preliminary: true, labels: ["6개월 이내"] },
    confidence: 0.9,
  },
]);

const dashboard = buildDashboard({
  company,
  grants: [soonGrant, tooOldGrant],
  asOf,
  limit: 10,
});

const soonMatch = dashboard.matches.find((match) => match.sourceId === soonGrant.grant.source_id);
assert.ok(soonMatch, "soon match should exist");
assert.equal(soonMatch.eligibility, "ineligible");
assert.equal(soonMatch.bucket, "soon");

const soonTrace = soonMatch.ruleTrace.find((trace) => trace.dimension === "biz_age");
assert.equal(soonTrace?.unlock?.kind, "time");
assert.equal(soonTrace?.unlock?.etaDate, "2026-08-01");

const soonRoadmapNode = dashboard.roadmap.find((node) => node.grantId === soonMatch.grantId);
assert.equal(soonRoadmapNode?.bucket, "soon");
assert.equal(soonRoadmapNode?.unlock?.kind, "time");
assert.equal(soonRoadmapNode?.unlock?.etaDate, "2026-08-01");

const tooOldMatch = dashboard.matches.find((match) => match.sourceId === tooOldGrant.grant.source_id);
assert.ok(tooOldMatch, "too old match should exist");
assert.equal(tooOldMatch.eligibility, "ineligible");
assert.equal(tooOldMatch.bucket, "preparable");
assert.equal(
  tooOldMatch.ruleTrace.find((trace) => trace.dimension === "biz_age")?.unlock,
  undefined,
);

const sheet = buildApplySheet({
  entry: {
    item: soonGrant,
    match: matchGrantCriteria(soonGrant.criteria, company),
  },
  asOf,
});
assert.equal(sheet.needsCheck.find((trace) => trace.dimension === "biz_age")?.unlock?.etaDate, "2026-08-01");

console.log(JSON.stringify({
  ok: true,
  checked: ["biz_age_min_match", "soon_bucket", "roadmap_time_unlock", "apply_sheet_unlock"],
  soon: {
    bucket: soonMatch.bucket,
    etaDate: soonTrace?.unlock?.etaDate,
  },
  tooOld: {
    bucket: tooOldMatch.bucket,
  },
}, null, 2));

function normalizedGrant(
  sourceId: string,
  title: string,
  criteria: GrantCriterion[],
): NormalizedGrant<Record<string, unknown>> {
  const grant: Grant = {
    source: "kstartup",
    source_id: sourceId,
    title,
    url: `https://example.test/grants/${sourceId}`,
    agency_jurisdiction: "중소벤처기업부",
    agency_operator: "창업진흥원",
    category_l1: "사업화",
    category_l2: null,
    apply_start: "2026-06-01",
    apply_end: "2026-09-30",
    apply_method: { online: "온라인 접수" },
    support_amount: { max: 10_000_000, unit: "KRW", per: "기업" },
    required_documents: null,
    status: "open",
    f_regions: ["41"],
    f_industries: [],
    f_biz_age_min_months: null,
    f_biz_age_max_months: null,
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
    parser_version: "fixture",
  };

  return {
    raw: {
      source: "kstartup",
      source_id: sourceId,
      payload: { sourceId, title },
      status: "normalized",
    },
    grant,
    criteria,
  };
}
