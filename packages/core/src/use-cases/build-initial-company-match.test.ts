import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { buildInitialCompanyMatch } from "./build-initial-company-match.js";

const company: CompanyProfile = {
  region: { code: "11", label: "서울" },
  industries: ["소프트웨어"],
  confidence: { region: 1, industry: 0.8 },
};

const grants: Array<NormalizedGrant<Record<string, never>>> = [
  grant("eligible", "서울 소프트웨어 사업", [{
    id: "region",
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["11"] },
    confidence: 1,
    source_span: "서울 소재 기업",
  }]),
  grant("question", "대표자 연령 사업", [{
    id: "age",
    dimension: "founder_age",
    kind: "required",
    operator: "between",
    value: { ranges: [{ min: 20, max: 39 }] },
    confidence: 1,
    source_span: "대표자 만 20세 이상 39세 이하",
  }]),
  grant("ineligible", "부산 기업 사업", [{
    id: "region",
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["26"] },
    confidence: 1,
    source_span: "부산 소재 기업",
  }]),
];

const result = buildInitialCompanyMatch({
  company,
  grants,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 2,
});

assert.equal(result.evaluatedGrantCount, 3, "counts는 화면 limit가 아닌 전체 공고를 평가해야 한다");
assert.equal(result.matches.length, 2, "첫 화면 공고만 limit해야 한다");
assert.equal(result.counts.eligible, 1);
assert.equal(result.counts.conditional, 1);
assert.equal(result.counts.ineligible, 1);
assert.equal(result.counts.recommendable, 1);
assert.equal(result.counts.reviewNeeded, 1);
assert.equal(result.counts.notRecommended, 1);
assert.equal(result.nextQuestion?.dimension, "founder_age");
assert.equal(result.asOf, "2026-07-12T00:00:00.000Z");

for (const businessKind of ["개인사업자", "법인"] as const) {
  const kindResult = buildInitialCompanyMatch({
    company: {
      target_types: [businessKind],
      list_completeness: { target_type: "partial" },
      confidence: { target_type: 1 },
    },
    grants: [
      grant("individual-only", "개인사업자 전용", [targetTypeCriterion("개인사업자")]),
      grant("corporation-only", "법인 전용", [targetTypeCriterion("법인")]),
    ],
    asOf: new Date("2026-07-12T00:00:00.000Z"),
    limit: 2,
  });
  assert.equal(kindResult.counts.eligible, 1, `${businessKind} exact hit는 통과해야 한다`);
  assert.equal(kindResult.counts.conditional, 0, `${businessKind} 상호배타 유형은 partial 축에서도 확정해야 한다`);
  assert.equal(kindResult.counts.ineligible, 1, `${businessKind} 반대 법적 유형 공고는 제외해야 한다`);
}

const partialBusinessKindOnly = buildInitialCompanyMatch({
  company: {
    target_types: ["개인사업자"],
    list_completeness: { target_type: "partial" },
    confidence: { target_type: 1 },
  },
  grants: [grant("startup-only", "창업기업 전용", [targetTypeCriterion("창업기업")])],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(partialBusinessKindOnly.counts.conditional, 1, "개인/법인을 알아도 창업기업 등 독립 target no-hit는 unknown이어야 한다");

const individualPath = buildInitialCompanyMatch({
  company: {
    target_types: ["개인사업자"],
    list_completeness: { target_type: "partial" },
    confidence: { target_type: 1 },
  },
  grants: businessKindQuestionGrants(),
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 2,
});
assert.equal(individualPath.counts.ineligible, 1, "권위 개인사업자 유형은 법인 전용 공고를 제외해야 한다");
assert.equal(individualPath.nextQuestion?.dimension, "founder_age", "개인사업자는 개인 전용 공고의 질문 경로를 따라야 한다");

const corporationPath = buildInitialCompanyMatch({
  company: {
    target_types: ["법인"],
    list_completeness: { target_type: "partial" },
    confidence: { target_type: 1 },
  },
  grants: businessKindQuestionGrants(),
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 2,
});
assert.equal(corporationPath.counts.ineligible, 1, "권위 법인 유형은 개인사업자 전용 공고를 제외해야 한다");
assert.equal(corporationPath.nextQuestion?.dimension, "revenue", "법인은 법인 전용 공고의 질문 경로를 따라야 한다");

const tied = [
  grant("tie-b", "동점 B", [targetTypeCriterion("개인사업자")]),
  grant("tie-a", "동점 A", [targetTypeCriterion("개인사업자")]),
];
const tieForward = buildInitialCompanyMatch({
  company: { target_types: ["개인사업자"], confidence: { target_type: 1 } },
  grants: tied,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 2,
});
const tieReverse = buildInitialCompanyMatch({
  company: { target_types: ["개인사업자"], confidence: { target_type: 1 } },
  grants: [...tied].reverse(),
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 2,
});
assert.deepEqual(
  tieForward.matches.map((match) => match.grantId),
  tieReverse.matches.map((match) => match.grantId),
  "동점 공고 정렬은 DB 입력 순서와 무관해야 cursor pagination이 안정적이다",
);

console.log("build-initial-company-match: ok");

function targetTypeCriterion(target: string): NormalizedGrant<Record<string, never>>["criteria"][number] {
  return {
    id: `target:${target}`,
    dimension: "target_type",
    kind: "required",
    operator: "in",
    value: { targets: [target] },
    confidence: 1,
    source_span: `${target} 대상`,
  };
}

function businessKindQuestionGrants(): Array<NormalizedGrant<Record<string, never>>> {
  return [
    grant("individual-question", "개인사업자 청년 대표 지원", [
      targetTypeCriterion("개인사업자"),
      {
        id: "individual:founder-age",
        dimension: "founder_age",
        kind: "required",
        operator: "between",
        value: { ranges: [{ min: 20, max: 39 }] },
        confidence: 1,
        source_span: "개인사업자이면서 대표자 만 20세 이상 39세 이하",
      },
    ]),
    grant("corporation-question", "법인 매출 기준 지원", [
      targetTypeCriterion("법인"),
      {
        id: "corporation:revenue",
        dimension: "revenue",
        kind: "required",
        operator: "lte",
        value: { max_krw: 1_000_000_000 },
        confidence: 1,
        source_span: "법인이면서 최근 연 매출 10억원 이하",
      },
    ]),
  ];
}

function grant(
  sourceId: string,
  title: string,
  criteria: NormalizedGrant<Record<string, never>>["criteria"],
): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title,
      agency_primary: "테스트기관",
      category_l1: "사업화",
      category_l2: null,
      support_amount: { unit: "KRW", per: "기업" },
      apply_start: "2026-07-01",
      apply_end: "2026-07-31",
      status: "open",
      apply_method: {},
      url: null,
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      f_authoring_mode: "unknown",
      benefits: [],
      overall_confidence: 1,
    },
    criteria,
    extraction_manifest: {
      grantId: `bizinfo:${sourceId}`,
      revision: `revision:${sourceId}`,
      sourceFieldsSeen: ["title", "criteria"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["eligibility"],
      extractorVersion: "test-reviewed-v1",
      completedAt: "2026-07-11T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
      reviewedAt: "2026-07-11T01:00:00.000Z",
    },
    raw: {
      source: "bizinfo",
      source_id: sourceId,
      collected_at: "2026-07-12T00:00:00.000Z",
      payload: {},
      status: "published",
    },
  };
}
