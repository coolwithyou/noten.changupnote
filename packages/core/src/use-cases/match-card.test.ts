import assert from "node:assert/strict";
import type { Grant, MatchResult, NormalizedGrant, RuleTraceEntry } from "@cunote/contracts";
import { deriveGrantBenefits, normalizeSupportAmount, toMatchCard } from "./match-card.js";

assert.deepEqual(
  normalizeSupportAmount({
    min_krw: 10_000_000,
    max_krw: 30_000_000,
    label: "1천만~3천만원",
    per: "건",
  }),
  {
    min: 10_000_000,
    max: 30_000_000,
    unit: "KRW",
    per: "건",
    label: "1천만~3천만원",
  },
);
assert.deepEqual(
  normalizeSupportAmount({ min: -1, amount: 20_000_000, value: 50_000_000, per: "개인" }),
  { min: -1, max: 20_000_000, unit: "KRW", per: "기업" },
);
assert.deepEqual(
  normalizeSupportAmount({ min: Number.POSITIVE_INFINITY, max: Number.NaN, label: null }),
  { min: null, max: null, unit: "KRW", per: "기업", label: null },
);

assert.equal(
  benefit(grant({ support_amount: { min: 1_000_000, max: null, unit: "KRW", per: "기업" } }), "funding")
    ?.source,
  "support_amount",
);
assert.equal(
  benefit(grant({ support_amount: { unit: "KRW", per: "기업", label: "사업화 바우처" } }), "funding")
    ?.source,
  "support_amount",
);
assert.equal(
  benefit(
    grant({ support_amount: { min: -1, max: 0, unit: "KRW", per: "기업", label: "기관별 상이" } }),
    "funding",
  ),
  undefined,
);

const unscoredStructured = benefit(
  grant({
    benefits: [{ family: "capability", label: "전문가 멘토링", source: "structured" }],
  }),
  "capability",
);
assert.equal(unscoredStructured?.confidence, 0.7);
assert.ok((unscoredStructured?.confidence ?? 1) < 0.8);

const unorderedBenefits: NonNullable<Grant["benefits"]> = [
  { family: "network", label: "연결", source: "structured", confidence: 0.9 },
  { family: "certification", label: "인증", source: "structured", confidence: 0.9 },
  { family: "market", label: "판로", source: "structured", confidence: 0.9 },
  { family: "space", label: "공간", source: "structured", confidence: 0.9 },
  { family: "capability", label: "제목 고신뢰", source: "title", confidence: 0.99 },
  { family: "capability", label: "구조화 저신뢰", source: "structured", confidence: 0.7 },
  { family: "capability", label: "구조화 고신뢰", source: "structured", confidence: 0.9 },
  { family: "loan", label: "융자", source: "structured", confidence: 0.9 },
  { family: "funding", label: "자금", source: "structured", confidence: 0.9 },
];
const ordered = deriveGrantBenefits(grant({ benefits: unorderedBenefits }));
assert.deepEqual(ordered.map((item) => item.family), ["funding", "loan", "capability", "space", "market"]);
assert.equal(benefitFromList(ordered, "capability")?.label, "구조화 고신뢰");
assert.deepEqual(
  deriveGrantBenefits(grant({ benefits: [...unorderedBenefits].reverse() })),
  ordered,
);

const positiveTitleFixtures: Array<[title: string, family: NonNullable<Grant["benefits"]>[number]["family"]]> = [
  ["초기창업기업 교육 지원", "capability"],
  ["초기창업기업 컨설팅 지원", "capability"],
  ["스타트업 특허 출원 지원사업", "certification"],
  ["스타트업 IP 출원 지원사업", "certification"],
  ["창업기업 입주기업 모집", "space"],
  ["중소기업 해외진출 지원", "market"],
  ["중소기업 판로개척 지원", "market"],
  ["소상공인 융자 지원", "loan"],
  ["소상공인 보증 지원", "loan"],
  ["스타트업 투자유치 프로그램", "network"],
  ["스타트업 네트워킹 프로그램", "network"],
];
for (const [title, family] of positiveTitleFixtures) {
  const matched = benefit(grant({ title }), family);
  assert.equal(matched?.source, "title", `${title}: ${family} title source`);
  assert.ok((matched?.confidence ?? 0) >= 0.8, `${title}: ${family} confidence`);
}

const negativeTitleFixtures = [
  "SVC Seoul Membership(Global) Recruitment Announcement",
  "청년창업센터 참여기업 모집",
  "2026 글로벌 스타트업 모집",
  "기업 운영 비용 절감 안내",
  "제품 시험 지원기업 모집",
  "창업 행사 참여기업 모집",
];
for (const title of negativeTitleFixtures) {
  assert.deepEqual(
    deriveGrantBenefits(grant({ title })).filter((item) => item.source === "title"),
    [],
    `${title}: broad title must not become a displayable benefit`,
  );
}

const contextOnly = deriveGrantBenefits(grant({
  category_l1: "글로벌 센터 비용 시험 행사",
}));
assert.ok(contextOnly.length > 0);
assert.ok(contextOnly.every((item) => item.source === "category" && item.confidence === 0.64));

// ── userConfirmedCount — 자가신고 확인 해소 entry 계상(확인 루프 Phase B 결정 3) ──────────
const plainPass = traceEntry({ result: "pass" });
const confirmedPass = traceEntry({ result: "pass", resolution: "confirmed_by_user" });
const confirmedFail = traceEntry({ result: "fail", resolution: "confirmed_by_user" });

// 확인 해소가 없으면 필드 자체를 싣지 않는다(confirmationQuestionCount 관례).
assert.ok(!("userConfirmedCount" in toMatchCard(matchedGrant([plainPass]))));
assert.ok(!("userConfirmedCount" in toMatchCard(matchedGrant([]))));
// pass 승격·fail 확정 모두 동일하게 계상한다(정직 표시 — open 승격이든 결격 확정이든).
assert.equal(toMatchCard(matchedGrant([confirmedPass, plainPass])).userConfirmedCount, 1);
assert.equal(toMatchCard(matchedGrant([confirmedPass, confirmedFail, plainPass])).userConfirmedCount, 2);
assert.equal(toMatchCard(matchedGrant([confirmedFail])).userConfirmedCount, 1);

console.log("match-card.test.ts: all assertions passed");

function traceEntry(overrides: Partial<RuleTraceEntry> = {}): RuleTraceEntry {
  return {
    dimension: "sanction",
    kind: "exclusion",
    operator: "exists",
    result: "unknown",
    message: "제재 여부 확인 필요",
    ...overrides,
  };
}

function matchedGrant(ruleTrace: RuleTraceEntry[]): { item: NormalizedGrant; match: MatchResult } {
  return {
    item: {
      raw: { source: "bizinfo", source_id: "confirm-test", payload: {}, status: "normalized" },
      grant: grant({ source_id: "confirm-test" }),
      criteria: [],
    },
    match: {
      eligibility: "conditional",
      fit_score: 50,
      rule_trace: ruleTrace,
      unknown_fields: [],
      ruleset_ver: "test",
      scoring_ver: "test",
      criteria_extracted: true,
      quality: {
        eligibilityConfidence: "medium",
        verificationCompleteness: 50,
        evidenceCoverage: 50,
        extractionReadiness: "structured_unreviewed",
      },
    },
  };
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    source: "bizinfo",
    source_id: "benefit-test",
    title: "참여기업 모집",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
    ...overrides,
  };
}

function benefit(grantValue: Grant, family: NonNullable<Grant["benefits"]>[number]["family"]) {
  return benefitFromList(deriveGrantBenefits(grantValue), family);
}

function benefitFromList(
  benefits: ReturnType<typeof deriveGrantBenefits>,
  family: NonNullable<Grant["benefits"]>[number]["family"],
) {
  return benefits.find((item) => item.family === family);
}
