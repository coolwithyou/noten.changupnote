// shadow-convert 픽스처 단위 테스트 (순수 함수 — DB·네트워크 미사용).
// 실행: pnpm lab:shadow:test
// 검증: correct 만 변환, needs_edit/wrong/unsure 제외·집계, 변환 결과 needs_review=false,
// sourceSpan→source_span 매핑, region value canonicalize 통과, span 필수 축의 sourceSpan
// 부재 강등 집계, missed_condition 집계, 배열 밖 criterionIndex 방어.
import assert from "node:assert/strict";
import { matchGrantCriteria } from "@cunote/core/matching/match";
import type {
  LabCriterion,
  LabReview,
  LabRun,
} from "@/lib/server/analysis-lab/lab-contract";
import {
  ANALYSIS_LAB_SHADOW_PARSER_VERSION,
  ANALYSIS_LAB_SHADOW_SOURCE_FIELD,
  convertReviewedLabRun,
  convertSelectedLabCriteria,
  inspectShadowConversionReport,
  shadowConversionIsGenericReleaseSafe,
  shadowConversionIsPromotionSafe,
} from "./shadow-convert";

function criterion(input: Partial<LabCriterion> & Pick<LabCriterion, "dimension" | "kind" | "operator" | "value">): LabCriterion {
  return {
    confidence: 0.9,
    sourceSpan: null,
    spanVerified: false,
    note: null,
    ...input,
  };
}

function fixtureRun(criteria: LabCriterion[]): LabRun {
  return {
    runId: "run-2026-07-22T000000.000Z-abc123",
    grantId: "00000000-0000-4000-8000-000000000001",
    source: "bizinfo",
    sourceId: "PBLN_TEST_1",
    title: "테스트 공고",
    model: "claude-opus-4-8",
    promptVersion: "lab-deep-v2",
    startedAt: "2026-07-22T00:00:00.000Z",
    durationMs: 1000,
    inputBlocks: [],
    inputTotalChars: 1000,
    inputSha256: "0".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
  };
}

function fixtureReview(input: Pick<LabReview, "criterionReviews" | "axisReviews">): LabReview {
  return {
    grantId: "00000000-0000-4000-8000-000000000001",
    runId: "run-2026-07-22T000000.000Z-abc123",
    reviewerEmail: "sw@noten.im",
    createdAt: "2026-07-22T01:00:00.000Z",
    updatedAt: "2026-07-22T01:00:00.000Z",
    overallNote: null,
    ...input,
  };
}

// ---- 시나리오: 판정 5종 혼합 + 강등 1건 + 누락 2건 ------------------------------

const run = fixtureRun([
  // 0: correct — region 라벨이 시도 코드로 canonicalize 되어야 한다.
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
    spanVerified: true,
  }),
  // 1: correct — span 필수 축(prior_award)에 sourceSpan 이 없어 other/text_only 강등 대상.
  criterion({
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self", self_kind: "current_similar", channel: "general" },
    sourceSpan: null,
  }),
  // 2: needs_edit — 변환 제외(건수만 집계).
  criterion({
    dimension: "biz_age",
    kind: "required",
    operator: "lte",
    value: { max_months: 84 },
    sourceSpan: "창업 7년 이내",
  }),
  // 3: wrong — 변환 제외.
  criterion({
    dimension: "size",
    kind: "required",
    operator: "in",
    value: { sizes: ["중소기업"] },
    sourceSpan: "중소기업",
  }),
  // 4: unsure — 변환 제외.
  criterion({
    dimension: "employees",
    kind: "required",
    operator: "gte",
    value: { min: 5 },
    sourceSpan: "상시근로자 5인 이상",
  }),
]);

const review = fixtureReview({
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
    { criterionIndex: 2, verdict: "needs_edit", note: "월수 재확인" },
    { criterionIndex: 3, verdict: "wrong", note: "원문에 없음" },
    { criterionIndex: 4, verdict: "unsure", note: "표현 모호" },
  ],
  axisReviews: [
    { dimension: "certification", verdict: "confirmed_absent", note: null },
    { dimension: "tax_compliance", verdict: "missed_condition", note: "국세 체납 결격 누락" },
    { dimension: "investment", verdict: "missed_condition", note: "투자유치 요건 누락" },
  ],
});

const { criteria, report } = convertReviewedLabRun(run, review);

// 검수 verdict 집계 — correct 만 변환 입력이 된다.
assert.deepEqual(report.verdicts, { correct: 2, needs_edit: 1, wrong: 1, unsure: 1 });
assert.equal(report.missedConditions, 2, "axisReviews 의 missed_condition 이 집계돼야 한다");
assert.equal(report.inputRows, 2);
assert.equal(report.converted, 2, "correct 2건이 전부 산출돼야 한다(강등 포함)");
assert.equal(report.downgraded, 1, "span 부재 prior_award 1건이 강등으로 집계돼야 한다");
assert.equal(report.dropped, 0);
assert.equal(report.error, null);
assert.equal(criteria.length, 2);

// 정상 변환분(region): needs_review=false + snake_case 매핑 + canonicalize 통과.
const region = criteria.find((item) => item.dimension === "region");
assert.ok(region, "region criterion 이 변환돼야 한다");
assert.equal(region.needs_review, false, "사람 검수 확정이므로 needs_review=false 여야 한다(핵심 계약)");
assert.equal(region.kind, "required");
assert.equal(region.operator, "in");
assert.equal(region.source_span, "서울 소재 기업", "sourceSpan→source_span 매핑");
assert.equal(region.source_field, ANALYSIS_LAB_SHADOW_SOURCE_FIELD);
assert.equal(region.parser_version, ANALYSIS_LAB_SHADOW_PARSER_VERSION);
assert.equal(region.id, "lab-shadow:PBLN_TEST_1:llm-1");
assert.equal(region.grant_id, "PBLN_TEST_1");
assert.deepEqual(
  (region.value as { regions?: string[] }).regions,
  ["11"],
  "region 라벨('서울특별시')이 시도 코드('11')로 canonicalize 돼야 한다",
);

// ---- 시나리오: 강등은 표현만 낮추고 자격 kind 및 matcher 극성을 보존 -----------

const semanticPreservation = convertReviewedLabRun(fixtureRun([
  criterion({
    dimension: "premises",
    kind: "required",
    operator: "exists",
    value: { note: "독립 사업장 보유" },
    sourceSpan: "독립된 사업장을 보유해야 한다.",
    spanVerified: true,
  }),
  criterion({
    dimension: "premises",
    kind: "preferred",
    operator: "in",
    value: { note: "화재에 취약한 건물 우선 지원" },
    sourceSpan: "화재에 취약한 건물 우선 지원",
    spanVerified: true,
  }),
  criterion({
    dimension: "export_performance",
    kind: "exclusion",
    operator: "gte",
    value: { note: "수출실적 기준 초과 기업 제외" },
    sourceSpan: "직전 연도 수출실적 10억원 이상 기업은 제외한다.",
    spanVerified: true,
  }),
]), fixtureReview({
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
    { criterionIndex: 2, verdict: "correct", note: null },
  ],
  axisReviews: [],
}));
assert.deepEqual(
  semanticPreservation.criteria.map((item) => item.kind),
  ["required", "preferred", "exclusion"],
  "M4 강등은 required/preferred/exclusion 의미를 바꾸지 않는다",
);
assert.deepEqual(
  semanticPreservation.criteria.map((item) => ({
    dimension: (item.value as Record<string, unknown>).original_dimension,
    operator: (item.value as Record<string, unknown>).original_operator,
    reason: (item.value as Record<string, unknown>).downgrade_reason,
  })),
  [
    { dimension: "premises", operator: "exists", reason: "reserved_dimension" },
    { dimension: "premises", operator: "in", reason: "reserved_dimension" },
    { dimension: "export_performance", operator: "gte", reason: "reserved_dimension" },
  ],
);
assert.equal(
  matchGrantCriteria([semanticPreservation.criteria[1]!], { confidence: {} }).eligibility,
  "eligible",
  "미확인 우대만으로 eligibility를 차단하지 않는다",
);
assert.equal(
  matchGrantCriteria([semanticPreservation.criteria[0]!], { confidence: {} }).eligibility,
  "conditional",
  "미확인 필수 조건은 자동 통과하지 않는다",
);
assert.equal(
  matchGrantCriteria([semanticPreservation.criteria[2]!], { confidence: {} }).eligibility,
  "conditional",
  "미확인 배제 조건은 자동 통과하지 않는다",
);

const premisesV1Value = {
  schemaVersion: "premises-v1",
  state: "registered_current_site",
  sidoCodes: ["11"],
  facilityTypes: ["headquarters", "factory"],
  facilitySemantics: "any",
  basisDate: "2026-09-09",
} as const;
const premisesV1Span = "2026년 9월 9일 현재 서울특별시에 등록된 본사 또는 공장을 둔 기업";
function projectPremisesV1(sourceSpan: string, needsReview: boolean) {
  return convertSelectedLabCriteria(fixtureRun([criterion({
    dimension: "premises",
    kind: "required",
    operator: "exists",
    value: premisesV1Value,
    sourceSpan,
    spanVerified: true,
  })]), { selections: [{ criterionIndex: 0, needsReview }] });
}
const reviewedPremisesV1 = projectPremisesV1(premisesV1Span, false);
assert.equal(reviewedPremisesV1.report.items?.[0]?.status, "converted");
assert.equal(reviewedPremisesV1.criteria[0]?.dimension, "premises");
assert.equal(reviewedPremisesV1.criteria[0]?.needs_review, false);
for (const [label, projected] of [
  ["unreviewed", projectPremisesV1(premisesV1Span, true)],
  [
    "district omission",
    projectPremisesV1(
      "2026년 9월 9일 현재 서울특별시 강남구에 등록된 본사 또는 공장을 둔 기업",
      false,
    ),
  ],
] as const) {
  assert.equal(projected.report.items?.[0]?.status, "downgraded", `${label} premises must be held`);
  assert.equal(projected.criteria[0]?.dimension, "other");
  assert.equal(
    (projected.criteria[0]?.value as { downgrade_reason?: string }).downgrade_reason,
    "reserved_dimension",
  );
}
const unverifiedPremisesV1 = convertSelectedLabCriteria(fixtureRun([criterion({
  dimension: "premises",
  kind: "required",
  operator: "exists",
  value: premisesV1Value,
  sourceSpan: premisesV1Span,
  spanVerified: false,
})]), { selections: [{ criterionIndex: 0, needsReview: false }] });
assert.equal(unverifiedPremisesV1.report.items?.[0]?.status, "downgraded");
assert.equal(
  (unverifiedPremisesV1.criteria[0]?.value as { downgrade_reason?: string }).downgrade_reason,
  "reserved_dimension",
  "semantic-looking text without exact sealed span verification cannot enter premises-v1",
);

const structuredDirection = convertReviewedLabRun(fixtureRun([
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울특별시 소재 기업",
    spanVerified: true,
  }),
  criterion({
    dimension: "region",
    kind: "exclusion",
    operator: "not_in",
    value: { regions: ["경기도"] },
    sourceSpan: "경기도 소재 기업 제외",
    spanVerified: true,
  }),
]), fixtureReview({
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
  ],
  axisReviews: [],
}));
assert.equal(
  matchGrantCriteria([structuredDirection.criteria[0]!], {
    region: { code: "41", label: "경기" },
    confidence: { region: 1 },
  }).eligibility,
  "ineligible",
  "확정 required 불일치는 기존 방향대로 탈락한다",
);
assert.equal(
  matchGrantCriteria([structuredDirection.criteria[1]!], {
    region: { code: "41", label: "경기" },
    confidence: { region: 1 },
  }).eligibility,
  "ineligible",
  "확정 exclusion 해당은 기존 방향대로 탈락한다",
);
assert.equal(structuredDirection.report.downgraded, 0, "무손실 not_in→in canonicalization은 강등이 아니다");
assert.deepEqual(structuredDirection.report.items?.map((item) => ({
  status: item.status,
  sourceOperator: item.source?.operator,
  projectedOperator: item.projected?.operator,
})), [
  { status: "converted", sourceOperator: "in", projectedOperator: "in" },
  { status: "converted", sourceOperator: "not_in", projectedOperator: "in" },
], "정상 canonicalization도 source/projected 연산자를 보고서에 보존한다");

// 강등분(prior_award, span 부재): other/text_only exclusion + needs_review=true 로 보존.
const downgraded = criteria.find((item) => item.dimension === "other");
assert.ok(downgraded, "span 부재 prior_award 는 other 로 강등돼야 한다");
assert.equal(downgraded.operator, "text_only");
assert.equal(downgraded.kind, "exclusion");
assert.equal(downgraded.needs_review, true, "강등분은 needs_review=true 로 남아 보고에 드러나야 한다");

// ---- 시나리오: 배열 밖 criterionIndex 방어 --------------------------------------

const outOfRange = convertReviewedLabRun(run, fixtureReview({
  criterionReviews: [{ criterionIndex: 99, verdict: "correct", note: null }],
  axisReviews: [],
}));
assert.equal(outOfRange.report.verdicts.correct, 1);
assert.equal(outOfRange.report.inputRows, 1, "범위 밖 selection도 항목별 실패로 전량 기록해야 한다");
assert.equal(outOfRange.report.dropped, 1);
assert.match(outOfRange.report.error ?? "", /criterion_index_out_of_range/);
assert.equal(outOfRange.report.items?.[0]?.status, "failed");
assert.equal(outOfRange.criteria.length, 0);

// ---- 시나리오: correct 0건 → 빈 산출 -------------------------------------------

const empty = convertReviewedLabRun(run, fixtureReview({
  criterionReviews: [{ criterionIndex: 0, verdict: "wrong", note: "원문에 없음" }],
  axisReviews: [{ dimension: "region", verdict: "missed_condition", note: "지역 조건 누락" }],
}));
assert.equal(empty.criteria.length, 0);
assert.equal(empty.report.converted, 0);
assert.equal(empty.report.missedConditions, 1);
assert.equal(empty.report.error, null);

// ---- 시나리오: 모집직무·업종/직무 미확정 조건은 검수가 놓쳐도 발행 차단 --------

const industryBoundary = convertReviewedLabRun(fixtureRun([
  criterion({
    dimension: "industry",
    kind: "required",
    operator: "in",
    value: { tags: ["IT"] },
    sourceSpan: "ㅇ 모집직무 : 경영·사무 / 광고·마케팅 / IT",
    note: "모집 직무 분야",
  }),
  criterion({
    dimension: "industry",
    kind: "required",
    operator: "text_only",
    value: {
      note: "기업 업종 요건인지 청년 배치 직무분야인지 원문상 확정되지 않는다.",
    },
    sourceSpan: "경영·사무 / 광고·마케팅 / IT 분야 고용보험 피보험자수 20인 이상 기업",
  }),
  criterion({
    dimension: "industry",
    kind: "required",
    operator: "in",
    value: { tags: ["정보통신업"] },
    sourceSpan: "정보통신업을 영위하는 중소기업만 신청할 수 있다.",
  }),
]), fixtureReview({
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
    { criterionIndex: 2, verdict: "correct", note: null },
  ],
  axisReviews: [],
}));
assert.equal(industryBoundary.report.inputRows, 3);
assert.equal(industryBoundary.report.converted, 1);
assert.equal(industryBoundary.report.dropped, 2);
assert.deepEqual(
  industryBoundary.criteria.map((item) => item.value),
  [{ tags: ["정보통신업"] }],
  "실제 신청기업 업종 조건만 발행한다",
);

// ---- 시나리오: 괄호형 배제 유형의 기관 예시 `등`은 target 목록을 열지 않는다 -------

const parentheticalExclusions = convertReviewedLabRun(fixtureRun([
  criterion({
    dimension: "target_type",
    kind: "exclusion",
    operator: "not_in",
    value: { targets: ["중앙행정기관"], list_semantics: "open" },
    sourceSpan: "- (중앙행정기관) 국토부, 행안부, 우체국, 세무서 등 참여불가",
    spanVerified: true,
  }),
  criterion({
    dimension: "target_type",
    kind: "exclusion",
    operator: "not_in",
    value: { targets: ["지방자치단체"], list_semantics: "open" },
    sourceSpan: "(지방자치단체) 서울시, 경기도, 지자체 산하 보건소 및 도서관 등 참여불가",
    spanVerified: true,
  }),
  criterion({
    dimension: "target_type",
    kind: "required",
    operator: "in",
    value: { targets: ["기업", "공공기관"], list_semantics: "open" },
    sourceSpan: "기업, 공공기관 등 참여 가능",
    spanVerified: true,
  }),
]), fixtureReview({
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
    { criterionIndex: 2, verdict: "correct", note: null },
  ],
  axisReviews: [],
}));
assert.deepEqual(
  parentheticalExclusions.criteria.map((item) =>
    (item.value as { list_semantics?: string }).list_semantics),
  ["closed", "closed", "open"],
  "괄호로 이름 붙인 단일 배제 유형만 closed로 교정하고 신청대상 열린 목록은 보존한다",
);

// ---- 시나리오: 같은 근거 문장의 서로 다른 원래 조건은 강등 후에도 공존 -----------

const sharedRequiredSpan = "본사 또는 공장은 안산에 위치하며 전년도 수출은 2천만불 이하여야 한다.";
const sharedRequired = convertSelectedLabCriteria(fixtureRun([
  criterion({
    dimension: "premises",
    kind: "required",
    operator: "in",
    value: { locations: ["안산"], facility_types: ["본사", "공장"] },
    sourceSpan: sharedRequiredSpan,
  }),
  criterion({
    dimension: "export_performance",
    kind: "required",
    operator: "lte",
    value: { max_usd: 20_000_000 },
    sourceSpan: sharedRequiredSpan,
  }),
]), {
  selections: [
    { criterionIndex: 0, needsReview: false },
    { criterionIndex: 1, needsReview: false },
  ],
});
assert.equal(sharedRequired.criteria.length, 2, sharedRequired.report.error ?? "서로 다른 조건 보존");
assert.deepEqual(sharedRequired.report.items?.map((item) => item.status), ["downgraded", "downgraded"]);
assert.deepEqual(
  sharedRequired.criteria.map((item) => (item.value as Record<string, unknown>).original_dimension),
  ["premises", "export_performance"],
);

const sharedPreferredSpan = "공동휴게시설 설치 가점 3점, 생활임금 서약 가점 2점";
const sharedPreferred = convertSelectedLabCriteria(fixtureRun([
  criterion({
    dimension: "premises",
    kind: "preferred",
    operator: "in",
    value: { facilities: ["공동휴게시설"], points: 3 },
    sourceSpan: sharedPreferredSpan,
  }),
  criterion({
    dimension: "other",
    kind: "preferred",
    operator: "text_only",
    value: { note: "생활임금 서약 가점 2점" },
    sourceSpan: sharedPreferredSpan,
  }),
]), {
  selections: [
    { criterionIndex: 0, needsReview: false },
    { criterionIndex: 1, needsReview: false },
  ],
});
assert.equal(sharedPreferred.criteria.length, 2, sharedPreferred.report.error ?? "서로 다른 가점 보존");
assert.deepEqual(sharedPreferred.criteria.map((item) => item.kind), ["preferred", "preferred"]);

// ---- 시나리오: 진짜 semantic duplicate는 provenance를 잃지 않고 양쪽 명시 보류 --

const trueDuplicate = convertSelectedLabCriteria(fixtureRun([
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
  }),
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
  }),
]), {
  selections: [
    { criterionIndex: 0, needsReview: false },
    { criterionIndex: 1, needsReview: false },
  ],
});
assert.equal(trueDuplicate.criteria.length, 0);
assert.equal(trueDuplicate.report.dropped, 2);
assert.match(trueDuplicate.report.error ?? "", /duplicate_semantic_criterion/);
assert.deepEqual(trueDuplicate.report.items?.map((item) => ({
  index: item.criterionIndex,
  status: item.status,
  related: item.relatedCriterionIndexes,
})), [
  { index: 0, status: "held_duplicate", related: [1] },
  { index: 1, status: "held_duplicate", related: [0] },
]);

// ---- v3 항목 accounting 오염과 알 수 없는 신규 버전은 fail-closed -------------

const validIntegrity = inspectShadowConversionReport(sharedRequired.report, sharedRequired.criteria);
assert.equal(validIntegrity.completeItemAccounting, true, validIntegrity.issues.join(","));
assert.equal(shadowConversionIsPromotionSafe({
  report: sharedRequired.report,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: [],
}), true);
const { items: _missingItems, ...v3WithoutItems } = sharedRequired.report;
assert.equal(shadowConversionIsPromotionSafe({
  report: v3WithoutItems,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: [],
}), false, "v3 items 누락은 legacy fallback으로 통과하면 안 된다");
assert.equal(shadowConversionIsPromotionSafe({
  report: {
    ...v3WithoutItems,
    contractVersion: "future-broken",
  } as unknown as typeof sharedRequired.report,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: [],
}), false, "알 수 없는 신규 버전도 fail-closed해야 한다");

const { contractVersion: _legacyContractVersion, ...legacyGenericShadowReport } = v3WithoutItems;
assert.equal(shadowConversionIsPromotionSafe({
  report: legacyGenericShadowReport,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: undefined,
}), false, "deep/launch promotion의 역사 scope 목록 엄격성은 유지한다");
assert.equal(shadowConversionIsGenericReleaseSafe({
  report: legacyGenericShadowReport,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: undefined,
}), true, "역사 human/mixed shadow는 무버전·무items·drop 0 계약을 계속 허용한다");
assert.equal(shadowConversionIsGenericReleaseSafe({
  report: { ...legacyGenericShadowReport, dropped: 1 },
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: undefined,
}), false, "역사 generic shadow도 실제 drop은 계속 거부한다");
assert.equal(shadowConversionIsGenericReleaseSafe({
  report: v3WithoutItems,
  criteria: sharedRequired.criteria,
  scopeRejectedCriterionIndexes: [],
}), false, "v3 missing items는 generic shadow에서도 legacy 호환으로 우회하지 못한다");
for (const mutate of [
  (report: typeof sharedRequired.report) => { report.items![0]!.outputCriterionId = "wrong-id"; },
  (report: typeof sharedRequired.report) => { report.items![0]!.source!.kind = "exclusion"; },
  (report: typeof sharedRequired.report) => { report.items![1]!.criterionIndex = 0; },
  (report: typeof sharedRequired.report) => { report.items![0]!.criterionIndex = -1; },
  (report: typeof sharedRequired.report) => {
    report.items![0]!.status = "future_status" as NonNullable<typeof report.items>[number]["status"];
  },
]) {
  const corrupted = structuredClone(sharedRequired.report);
  mutate(corrupted);
  assert.equal(shadowConversionIsPromotionSafe({
    report: corrupted,
    criteria: sharedRequired.criteria,
    scopeRejectedCriterionIndexes: [],
  }), false, "항목 ID/kind/index/status 오염은 fail-closed해야 한다");
}

console.log("shadow-convert tests: ok");
