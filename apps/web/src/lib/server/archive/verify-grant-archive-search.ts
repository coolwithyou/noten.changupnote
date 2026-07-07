import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  applyMethodChannelLabel,
  buildGrantArchiveFacets,
  buildGrantArchiveResult,
  benefitFamilyLabel,
  criterionDimensionLabel,
} from "./grantArchiveSearch";

const entries: NormalizedGrant[] = [
  {
    raw: {
      source: "kstartup",
      source_id: "archive-1",
      payload: {},
      status: "published",
    },
    grant: {
      id: "grant-1",
      source: "kstartup",
      source_id: "archive-1",
      title: "서울 청년 창업 사업화 지원",
      agency_jurisdiction: "서울특별시",
      agency_operator: "서울창업허브",
      category_l1: "사업화",
      category_l2: "청년창업",
      apply_start: "2026-07-01T00:00:00.000Z",
      apply_end: "2026-07-20T00:00:00.000Z",
      apply_method: { label: "온라인 신청" },
      support_amount: { max: 50_000_000, unit: "KRW", per: "기업" },
      required_documents: [
        { name: "사업계획서", required: true, source: "self", preparation_type: "write", category: "business_plan" },
      ],
      benefits: [
        { family: "funding", label: "사업화 자금", source: "structured", confidence: 0.96 },
        { family: "capability", label: "멘토링", source: "structured", confidence: 0.91 },
      ],
      status: "open",
      f_regions: ["서울"],
      f_industries: ["소프트웨어"],
      f_sizes: [],
      f_founder_traits: ["청년"],
      f_required_certs: [],
      f_apply_methods: ["online", "email"],
      overall_confidence: 0.94,
    },
    criteria: [
      {
        dimension: "region",
        operator: "in",
        kind: "required",
        value: { regions: ["서울"], labels: ["서울"] },
        confidence: 0.96,
      },
      {
        dimension: "biz_age",
        operator: "between",
        kind: "required",
        value: { min_months: 0, max_months: 84, labels: ["7년 이내"] },
        confidence: 0.9,
      },
      {
        dimension: "target_type",
        operator: "in",
        kind: "required",
        value: { targets: ["청년창업기업"] },
        confidence: 0.88,
      },
    ],
  },
  {
    raw: {
      source: "bizinfo",
      source_id: "archive-2",
      payload: {},
      status: "published",
    },
    grant: {
      id: "grant-2",
      source: "bizinfo",
      source_id: "archive-2",
      title: "수출 판로 개척 패키지",
      agency_jurisdiction: "중소벤처기업부",
      agency_operator: "중소기업유통센터",
      category_l1: "판로",
      category_l2: "수출",
      apply_start: "2026-08-01T00:00:00.000Z",
      apply_end: "2026-08-31T00:00:00.000Z",
      apply_method: { text: "방문 접수처 안내" },
      support_amount: null,
      required_documents: [],
      benefits: [
        { family: "market", label: "수출 판로", source: "structured", confidence: 0.93 },
        { family: "network", label: "바이어 연계", source: "structured", confidence: 0.87 },
      ],
      status: "upcoming",
      f_regions: ["전국"],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.82,
    },
    criteria: [
      {
        dimension: "region",
        operator: "in",
        kind: "required",
        value: { nationwide: true, regions: ["전국"], labels: ["전국"] },
        confidence: 0.9,
      },
      {
        dimension: "industry",
        operator: "text_only",
        kind: "required",
        value: { note: "수출 가능 품목 보유 기업" },
        confidence: 0.62,
        needs_review: true,
      },
    ],
  },
];

const asOf = new Date("2026-07-01T00:00:00.000Z");

const funding = buildGrantArchiveResult({
  entries,
  asOf,
  query: { benefitFamilies: ["funding"] },
});
assert.equal(funding.total, 1);
assert.equal(funding.items[0]?.grantId, "grant-1");
assert.equal(funding.items[0]?.draftableDocumentCount, 1);
assert.equal(funding.items[0]?.applyEnd, "2026-07-20");
assert.equal(funding.items[0]?.dDay, 19);

const market = buildGrantArchiveResult({
  entries,
  asOf,
  query: { benefitFamilies: ["market"], statuses: ["upcoming"] },
});
assert.equal(market.total, 1);
assert.equal(market.items[0]?.source, "bizinfo");

const condition = buildGrantArchiveResult({
  entries,
  asOf,
  query: {
    criterionFilters: [{ dimension: "region", values: ["서울"] }],
  },
});
assert.equal(condition.total, 1);
assert.equal(condition.items[0]?.conditionSummary.some((item) => item.dimension === "biz_age"), true);

const quality = buildGrantArchiveResult({
  entries,
  asOf,
  query: { needsReview: true, textOnly: true },
});
assert.equal(quality.total, 1);
assert.equal(quality.items[0]?.textOnlyCriteriaCount, 1);

const paging = buildGrantArchiveResult({
  entries,
  asOf,
  query: { limit: 1 },
});
assert.equal(paging.items.length, 1);
assert.equal(paging.hasMore, true);
assert.equal(paging.cursor, "1");

assert.equal(benefitFamilyLabel("capability"), "역량강화");
assert.equal(criterionDimensionLabel("target_type"), "신청 대상");
assert.equal(applyMethodChannelLabel("online"), "온라인 접수");

// 접수방법 필터 — 정규화된 f_apply_methods 사용(grant-1: online·email).
const onlineApply = buildGrantArchiveResult({
  entries,
  asOf,
  query: { applyMethods: ["online"] },
});
assert.equal(onlineApply.total, 1);
assert.equal(onlineApply.items[0]?.grantId, "grant-1");
assert.deepEqual(onlineApply.items[0]?.applyMethods, ["online", "email"]);

// 접수방법 필터 — 레거시(f_apply_methods 미백필)는 apply_method jsonb 즉석 분류 폴백(grant-2: text→visit).
const visitApply = buildGrantArchiveResult({
  entries,
  asOf,
  query: { applyMethods: ["visit"] },
});
assert.equal(visitApply.total, 1);
assert.equal(visitApply.items[0]?.source, "bizinfo");
assert.deepEqual(visitApply.items[0]?.applyMethods, ["visit"]);

const facets = buildGrantArchiveFacets({
  entries,
  asOf,
  query: { statuses: ["open"], benefitFamilies: ["funding"] },
});
assert.equal(facets.filteredTotal, 1);
assert.equal(facets.benefits.find((item) => item.value === "funding")?.selected, true);
assert.equal(facets.sources.find((item) => item.value === "kstartup")?.count, 1);
assert.equal(facets.criteria.find((item) => item.dimension === "region")?.values[0]?.value, "서울");

const applyMethodFacets = buildGrantArchiveFacets({ entries, asOf });
assert.equal(applyMethodFacets.applyMethods.find((item) => item.value === "online")?.count, 1);
assert.equal(applyMethodFacets.applyMethods.find((item) => item.value === "email")?.count, 1);
assert.equal(applyMethodFacets.applyMethods.find((item) => item.value === "visit")?.count, 1);

const selectedApplyFacets = buildGrantArchiveFacets({
  entries,
  asOf,
  query: { applyMethods: ["online"] },
});
assert.equal(selectedApplyFacets.applyMethods.find((item) => item.value === "online")?.selected, true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "archive_benefit_filter",
    "archive_status_filter",
    "archive_criterion_filter",
    "archive_quality_filter",
    "archive_pagination",
    "archive_labels",
    "archive_facets",
    "archive_apply_method_filter",
    "archive_apply_method_fallback",
    "archive_apply_method_facets",
  ],
  totalFixtures: entries.length,
}, null, 2));
