import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NormalizedGrant } from "@cunote/contracts";
import { GrantArchivePageView } from "./GrantArchivePageView";
import {
  buildGrantArchiveFacets,
  buildGrantArchiveResult,
  criterionDimensionLabel,
  type GrantArchiveQuery,
  type GrantArchiveView,
} from "@/lib/server/archive/grantArchiveSearch";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const asOf = new Date("2026-07-01T00:00:00.000Z");

const entries: NormalizedGrant[] = [
  {
    raw: {
      source: "bizinfo",
      source_id: "ui-long-title",
      payload: {},
      status: "published",
    },
    grant: {
      id: "00000000-0000-4000-8000-000000000101",
      source: "bizinfo",
      source_id: "ui-long-title",
      title: "서울특별시 초장문 공고명 검증을 위한 XR 인공지능 SaaS 전환 및 글로벌 판로개척 통합 패키지 지원사업 참여기업 모집 공고",
      url: "https://example.com/long-title",
      agency_jurisdiction: "서울특별시",
      agency_operator: "서울경제진흥원 초장문 기관명 검증 전담부서",
      category_l1: "기술",
      category_l2: "기술사업화/이전/지도",
      apply_start: "2026-06-01",
      apply_end: "2026-07-20",
      support_amount: { max: 70_000_000, unit: "KRW", per: "기업" },
      required_documents: [
        { name: "사업계획서", required: true, source: "self", preparation_type: "write", category: "business_plan" },
      ],
      benefits: [
        { family: "funding", label: "사업화 자금", source: "structured", confidence: 0.98 },
        { family: "market", label: "판로", source: "structured", confidence: 0.92 },
      ],
      status: "open",
      f_regions: ["서울"],
      f_industries: ["AI", "SaaS"],
      f_sizes: ["중소기업"],
      f_founder_traits: ["청년"],
      f_required_certs: ["벤처기업"],
      overall_confidence: 0.96,
    },
    criteria: [
      criterion("region", { labels: ["서울"], regions: ["서울"] }),
      criterion("biz_age", { labels: ["7년 이내"], max_months: 84 }),
      criterion("industry", { tags: ["AI", "SaaS"] }),
      criterion("size", { sizes: ["중소기업"] }),
      criterion("revenue", { note: "매출 10억 이하" }),
      criterion("employees", { note: "근로자 5인 이상" }),
      criterion("founder_age", { labels: ["39세 이하"] }),
      criterion("founder_trait", { traits: ["청년"] }),
      criterion("certification", { certs: ["벤처기업"] }),
      criterion("prior_award", { note: "최근 3년 동일사업 수혜 제외" }),
      criterion("ip", { note: "특허 보유 우대" }),
      criterion("target_type", { targets: ["창업기업"] }),
      criterion("business_status", { note: "정상 영업 중" }),
      criterion("other", { note: "컨소시엄 가능" }),
    ],
  },
  {
    raw: {
      source: "kstartup",
      source_id: "ui-dateless",
      payload: {},
      status: "published",
    },
    grant: {
      id: "00000000-0000-4000-8000-000000000102",
      source: "kstartup",
      source_id: "ui-dateless",
      title: "마감일 없는 상시 접수 공고",
      agency_jurisdiction: "전국",
      agency_operator: "창업진흥원",
      category_l1: "창업",
      category_l2: "멘토링",
      apply_start: null,
      apply_end: null,
      support_amount: null,
      required_documents: [],
      benefits: [
        { family: "capability", label: "멘토링", source: "structured", confidence: 0.9 },
      ],
      status: "unknown",
      f_regions: ["전국"],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.74,
    },
    criteria: [
      criterion("region", { nationwide: true, labels: ["전국"], regions: ["전국"] }),
    ],
  },
  {
    raw: {
      source: "bizinfo",
      source_id: "ui-agency-primary",
      payload: {},
      status: "published",
    },
    grant: {
      id: "00000000-0000-4000-8000-000000000103",
      source: "bizinfo",
      source_id: "ui-agency-primary",
      title: "주관기관 우선 표시 검증 공고",
      agency_jurisdiction: "부산광역시",
      agency_operator: "부산테크노파크",
      agency_primary: "주관기관표시검증원",
      category_l1: "창업",
      category_l2: "시설공간",
      apply_start: "2026-06-10",
      apply_end: "2026-08-10",
      support_amount: null,
      required_documents: [],
      benefits: [
        { family: "space", label: "공간", source: "structured", confidence: 0.9 },
      ],
      status: "open",
      f_regions: ["부산"],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.82,
    },
    criteria: [
      criterion("region", { labels: ["부산"], regions: ["부산"] }),
    ],
  },
];

const listHtml = renderArchive("list", {});
assert.ok(listHtml.includes("초장문 공고명 검증"));
assert.ok(listHtml.includes("서울경제진흥원 초장문 기관명 검증 전담부서"));
assert.ok(listHtml.includes("기관/분야"));
assert.ok(listHtml.includes("지원 혜택"));
assert.ok(listHtml.includes("저장"));

// 주관기관 필터가 지역/부처·수행기관 체크박스 그룹을 대체한다.
assert.ok(listHtml.includes("주관기관"));
assert.ok(!listHtml.includes("지역/부처"), "removed agency jurisdiction group still present");
assert.ok(!listHtml.includes("수행기관"), "removed agency operator group still present");

// 목록 행은 agencyPrimary를 우선 표시하고, 있을 때는 수행기관 폴백을 렌더하지 않는다.
assert.ok(listHtml.includes("주관기관표시검증원"));
assert.ok(!listHtml.includes("부산테크노파크"), "agencyPrimary should take precedence over operator fallback");

// 선택된 주관기관은 name="agency" hidden input과 제거 가능한 칩으로 GET 폼에 편입된다.
const agencyHtml = renderArchive("list", { agencies: ["주관기관표시검증원"] });
assert.ok(agencyHtml.includes('name="agency"'));
assert.ok(agencyHtml.includes('value="주관기관표시검증원"'));
assert.ok(agencyHtml.includes('role="combobox"'));
assert.ok(agencyHtml.includes("제거"));
for (const dimension of [
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "business_status",
  "other",
] as const) {
  assert.ok(listHtml.includes(criterionDimensionLabel(dimension)), `missing criterion label: ${dimension}`);
}

const calendarHtml = renderArchive("calendar", {});
assert.ok(calendarHtml.includes("마감일 기준"));
assert.ok(calendarHtml.includes("접수 중"));
assert.ok(calendarHtml.includes("마감일 확인 필요"));
assert.ok(calendarHtml.includes("마감일 없는 상시 접수 공고"));

const ganttHtml = renderArchive("gantt", {});
assert.ok(ganttHtml.includes("접수 기간 기준"));
assert.ok(ganttHtml.includes("기간 확인"));
assert.ok(ganttHtml.includes("접수 기간 확인 필요"));

const emptyHtml = renderArchive("list", { q: "존재하지않는검색어" });
assert.ok(emptyHtml.includes("조건에 맞는 공고가 없습니다."));
assert.ok(emptyHtml.includes("0건 중 0건 표시"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "archive_ui_long_title",
    "archive_ui_all_criterion_filters",
    "archive_ui_agency_category_facets",
    "archive_ui_agency_filter",
    "archive_ui_agency_primary_row",
    "archive_ui_empty_state",
    "archive_ui_calendar_grid",
    "archive_ui_gantt_axis",
    "archive_ui_dateless_items",
  ],
}, null, 2));

function renderArchive(view: GrantArchiveView, query: GrantArchiveQuery): string {
  const currentParams = new URLSearchParams();
  currentParams.set("view", view);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") currentParams.set(key, value);
  }
  const viewQuery = { ...query, view, limit: 20 } satisfies GrantArchiveQuery;
  const archive = buildGrantArchiveResult({ entries, query: viewQuery, asOf });
  const facets = buildGrantArchiveFacets({ entries, query: viewQuery, asOf });

  return renderToStaticMarkup(
    <GrantArchivePageView
      archive={archive}
      currentParams={currentParams}
      facets={facets}
      query={viewQuery}
      queryError={null}
      user={{ name: "검증 사용자", email: "verify@example.com" }}
    />,
  );
}

function criterion(
  dimension: NormalizedGrant["criteria"][number]["dimension"],
  value: Record<string, unknown>,
): NormalizedGrant["criteria"][number] {
  return {
    dimension,
    operator: "text_only",
    kind: "required",
    value,
    confidence: 0.9,
    raw_text: String(value.note ?? value.labels ?? value.tags ?? value.regions ?? dimension),
  };
}
