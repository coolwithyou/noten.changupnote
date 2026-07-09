import assert from "node:assert/strict";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import {
  buildTeaser,
  deriveWriteSupport,
  sortMatchedGrants,
  toMatchCard,
  matchGrantCriteria,
} from "../src/index.js";

// ── deriveWriteSupport: 작성형 서류 추출 → ai_draft ──────────────────
assert.equal(
  deriveWriteSupport(grantFixture({
    f_authoring_mode: "file_form",
    required_documents: [writableDocument("사업계획서")],
  })),
  "ai_draft",
);
// 웹폼 사업이라도 작성형 서류(사업계획서 업로드 등)가 있으면 초안 지원이 정확한 약속.
assert.equal(
  deriveWriteSupport(grantFixture({
    f_authoring_mode: "web_form",
    required_documents: [writableDocument("사업계획서")],
  })),
  "ai_draft",
);
// 동의서·서약서만 있으면 초안 대상이 아니다.
assert.equal(
  deriveWriteSupport(grantFixture({
    f_authoring_mode: "web_form",
    required_documents: [{
      name: "개인정보 동의서",
      required: true,
      source: "self" as const,
      category: "consent_or_pledge" as const,
      preparation_type: "write" as const,
    }],
  })),
  "web_form_guide",
);
// 서류 미추출 웹폼 → web_form_guide, 서류 미추출 file_form → unknown(초안 과약속 금지).
assert.equal(deriveWriteSupport(grantFixture({ f_authoring_mode: "web_form" })), "web_form_guide");
assert.equal(deriveWriteSupport(grantFixture({ f_authoring_mode: "file_form" })), "unknown");
assert.equal(deriveWriteSupport(grantFixture({})), "unknown");

// ── toMatchCard: authoringMode·writeSupport 가 카드에 실린다 ─────────
{
  const entry = matchedEntry("card-1", {
    f_authoring_mode: "file_form",
    required_documents: [writableDocument("지원사업 신청서")],
  });
  const card = toMatchCard(entry);
  assert.equal(card.authoringMode, "file_form");
  assert.equal(card.writeSupport, "ai_draft");
}
{
  const card = toMatchCard(matchedEntry("card-2", {}));
  assert.equal(card.authoringMode, "unknown");
  assert.equal(card.writeSupport, "unknown");
}

// ── sortMatchedGrants: 같은 적격도에서는 작성 도움 가능한 사업이 먼저 ──
{
  // 두 공고 모두 동일 criteria(적격) — fitScore 동일 조건에서 writeSupport 만 다르게.
  const noSupport = matchedEntry("no-support", {});
  const aiDraft = matchedEntry("ai-draft", {
    required_documents: [writableDocument("사업계획서")],
  });
  const webForm = matchedEntry("web-form", { f_authoring_mode: "web_form" });

  const sorted = sortMatchedGrants([noSupport, webForm, aiDraft]);
  assert.deepEqual(
    sorted.map((entry) => entry.item.grant.source_id),
    ["ai-draft", "web-form", "no-support"],
    "동일 적격도·적합도에서 ai_draft → web_form_guide → unknown 순",
  );
}
{
  // 조건 미구조화(criteria_extracted=false) 강등은 writeSupport 보다 우선한다.
  const unscoredWithDocs = matchedEntry("unscored", {
    required_documents: [writableDocument("사업계획서")],
  }, { criteria: false });
  const scoredNoDocs = matchedEntry("scored", {});
  const sorted = sortMatchedGrants([unscoredWithDocs, scoredNoDocs]);
  assert.deepEqual(sorted.map((entry) => entry.item.grant.source_id), ["scored", "unscored"]);
}

// ── buildTeaser: 티저 매치 카드까지 신호가 흐른다 ─────────────────────
{
  const teaser = buildTeaser({
    company: { name: "검증 기업", confidence: {} },
    grants: [
      normalizedGrantFixture("teaser-1", {
        required_documents: [writableDocument("지원사업 신청서")],
      }),
      normalizedGrantFixture("teaser-2", { f_authoring_mode: "web_form" }),
    ],
    asOf: new Date("2026-07-01T00:00:00.000Z"),
  });
  const byId = new Map(teaser.matches.map((match) => [match.sourceId, match]));
  assert.equal(byId.get("teaser-1")?.writeSupport, "ai_draft");
  assert.equal(byId.get("teaser-2")?.writeSupport, "web_form_guide");
}

console.log("verify-write-support: all assertions passed");

// ── fixtures ─────────────────────────────────────────────────────────

function writableDocument(name: string) {
  return {
    name,
    required: true,
    source: "self" as const,
    category: "business_plan" as const,
    preparation_type: "write" as const,
  };
}

function grantFixture(overrides: Partial<Grant>): Grant {
  return {
    source: "kstartup",
    source_id: "fixture",
    title: "작성 지원 검증 공고",
    url: null,
    agency_jurisdiction: null,
    agency_operator: null,
    category_l1: null,
    category_l2: null,
    apply_start: "2026-06-01",
    apply_end: "2026-09-30",
    apply_method: { online: "온라인 접수" },
    support_amount: { max: 10_000_000, unit: "KRW", per: "기업" },
    required_documents: null,
    status: "open",
    f_regions: [],
    f_industries: [],
    f_biz_age_min_months: null,
    f_biz_age_max_months: null,
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
    parser_version: "fixture",
    ...overrides,
  };
}

function normalizedGrantFixture(
  sourceId: string,
  overrides: Partial<Grant>,
): NormalizedGrant<Record<string, unknown>> {
  const grant = grantFixture({ ...overrides, source_id: sourceId });
  return {
    raw: {
      source: "kstartup",
      source_id: sourceId,
      payload: { sourceId },
      status: "normalized",
    },
    grant,
    criteria: [],
  };
}

function matchedEntry(
  sourceId: string,
  overrides: Partial<Grant>,
  options: { criteria?: boolean } = {},
) {
  const item = normalizedGrantFixture(sourceId, overrides);
  if (options.criteria !== false) {
    item.criteria = [{
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: [], labels: [], nationwide: true },
      confidence: 0.95,
    }];
  }
  return {
    item,
    match: matchGrantCriteria(item.criteria, { name: "검증 기업", confidence: {} }),
  };
}
