import assert from "node:assert/strict";

process.env.CUNOTE_REPOSITORY_ADAPTER = "runtime";
process.env.CUNOTE_WEB_DATA_SOURCE = "sample";
process.env.CUNOTE_WEB_INCLUDE_BIZINFO_SAMPLE = "true";

const asOf = new Date("2026-07-01T00:00:00.000Z");

const { loadServiceGrants } = await import("@/lib/server/serviceData");
const { loadGrantArchive, loadGrantArchiveFacets, searchGrantAgencies } = await import("./grantArchiveData");
const { parseGrantArchiveSearchParams } = await import("./grantArchiveQuery");

const serviceEntries = await loadServiceGrants({ limit: 8, asOf });
assert.ok(serviceEntries.length > 0, "service sample grants should load");
assert.ok(
  serviceEntries.some((entry) => (entry.grant.benefits?.length ?? 0) > 0),
  "service sample grants should include structured benefits",
);

const archive = await loadGrantArchive({
  asOf,
  query: { benefitFamilies: ["funding"], limit: 5 },
});
assert.equal(archive.items.length > 0, true);
assert.ok(archive.items.every((item) => item.benefits.some((benefit) => benefit.family === "funding")));
assert.ok(archive.total >= archive.items.length);

const facets = await loadGrantArchiveFacets({
  asOf,
  query: { benefitFamilies: ["funding"], limit: 5 },
});
assert.equal(facets.benefits.find((option) => option.value === "funding")?.selected, true);
assert.ok(facets.sources.length > 0);
assert.ok(facets.criteria.length > 0);

const invalidArchiveQuery = parseGrantArchiveSearchParams(new URLSearchParams("source=invalid"));
assert.equal(invalidArchiveQuery.ok, false);
if (!invalidArchiveQuery.ok) {
  assert.equal(invalidArchiveQuery.error.status, 400);
  assert.equal(invalidArchiveQuery.error.code, "invalid_archive_query");
  assert.equal(invalidArchiveQuery.error.field, "source");
}

const invalidFacetQuery = parseGrantArchiveSearchParams(new URLSearchParams("benefit=invalid"));
assert.equal(invalidFacetQuery.ok, false);
if (!invalidFacetQuery.ok) {
  assert.equal(invalidFacetQuery.error.status, 400);
  assert.equal(invalidFacetQuery.error.code, "invalid_archive_query");
  assert.equal(invalidFacetQuery.error.field, "benefit");
}

// 주관기관 파서 — agency 파라미터를 콤마/중복 정규화하여 agencies 로 파싱.
const agencyQuery = parseGrantArchiveSearchParams(new URLSearchParams("agency=창업진흥원,중소기업유통센터,창업진흥원"));
assert.equal(agencyQuery.ok, true);
if (agencyQuery.ok) {
  assert.deepEqual(agencyQuery.query.agencies, ["창업진흥원", "중소기업유통센터"]);
}

// 주관기관 자동완성 — 라우트 계약(응답 형태) 및 비-drizzle 폴백 경로 검증.
const agencySearch = await searchGrantAgencies({ limit: 5 });
assert.equal(typeof agencySearch.generatedAt, "string");
assert.ok(Array.isArray(agencySearch.options));
assert.ok(agencySearch.options.length <= 5);
assert.ok(agencySearch.options.every((option) =>
  typeof option.value === "string" && option.label === option.value && typeof option.count === "number"
));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "service_sample_benefits",
    "archive_runtime_benefit_filter",
    "archive_facet_runtime_shape",
    "archive_api_invalid_source_query",
    "archive_facets_invalid_benefit_query",
    "archive_agency_query_parse",
    "archive_agency_autocomplete_shape",
  ],
  serviceEntries: serviceEntries.length,
  archiveTotal: archive.total,
  agencyOptions: agencySearch.options.length,
}, null, 2));
