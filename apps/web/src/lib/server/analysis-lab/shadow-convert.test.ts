// shadow-convert 픽스처 단위 테스트 (순수 함수 — DB·네트워크 미사용).
// 실행: pnpm lab:shadow:test
// 검증: correct 만 변환, needs_edit/wrong/unsure 제외·집계, 변환 결과 needs_review=false,
// sourceSpan→source_span 매핑, region value canonicalize 통과, span 필수 축의 sourceSpan
// 부재 강등 집계, missed_condition 집계, 배열 밖 criterionIndex 방어.
import assert from "node:assert/strict";
import type {
  LabCriterion,
  LabReview,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  ANALYSIS_LAB_SHADOW_PARSER_VERSION,
  ANALYSIS_LAB_SHADOW_SOURCE_FIELD,
  convertReviewedLabRun,
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
assert.equal(outOfRange.report.inputRows, 0, "범위 밖 인덱스는 변환 입력이 되지 않아야 한다");
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

console.log("shadow-convert tests: ok");
