import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  buildIndependentReviewSystemPrompt,
  deriveIndependentReviewAxes,
  deriveIndependentReviewConsensus,
  deriveSingleIndependentReviewFindings,
  normalizeReviewSequences,
} from "./independent-review-packet";

const findings = deriveIndependentReviewConsensus(7, {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "needs_edit", note: "OR 경로 범위 손실" },
    { criterionIndex: 2, verdict: "wrong", note: "협업 주제를 업종으로 오인" },
    { criterionIndex: 3, verdict: "unsure", note: "원문 범위 불명확" },
    { criterionIndex: 4, verdict: "needs_edit", note: "단독 판정" },
  ],
  axisReviews: [
    { dimension: "credit_status", verdict: "missed_condition", matchImpact: "eligibility", note: "채무불이행 누락" },
    { dimension: "region", verdict: "confirmed_absent", matchImpact: "not_applicable", note: null },
  ],
}, {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "needs_edit", note: "대안 한정 누락" },
    { criterionIndex: 2, verdict: "wrong", note: "신청기업 업종이 아님" },
    { criterionIndex: 3, verdict: "unsure", note: "추가 확인 필요" },
    { criterionIndex: 4, verdict: "correct", note: null },
  ],
  axisReviews: [
    { dimension: "credit_status", verdict: "missed_condition", matchImpact: "eligibility", note: "부도·채무불이행 누락" },
    { dimension: "region", verdict: "confirmed_absent", matchImpact: "not_applicable", note: null },
  ],
});

assert.deepEqual(
  findings.map((finding) => [finding.kind, finding.key, finding.verdict, finding.classification]),
  [
    ["axis", "credit_status", "missed_condition", "defect"],
    ["criterion", 1, "needs_edit", "defect"],
    ["criterion", 2, "wrong", "defect"],
    ["criterion", 3, "unsure", "unresolved"],
  ],
  "양쪽이 같은 정상 판정을 한 항목과 단독 결함은 합의 결함에서 제외한다",
);

const codexOnlyFindings = deriveSingleIndependentReviewFindings(8, {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "needs_edit", note: "범위 손실" },
    { criterionIndex: 2, verdict: "unsure", note: "원문 모호" },
  ],
  axisReviews: [
    { dimension: "region", verdict: "confirmed_absent", note: null },
    { dimension: "credit_status", verdict: "missed_condition", note: "채무불이행 누락" },
  ],
});

assert.deepEqual(
  codexOnlyFindings.map((finding) => [finding.kind, finding.key, finding.verdict, finding.classification]),
  [
    ["axis", "credit_status", "missed_condition", "defect"],
    ["criterion", 1, "needs_edit", "defect"],
    ["criterion", 2, "unsure", "unresolved"],
  ],
  "Codex 단독 검수에서는 모든 비정상 판정을 보류 finding으로 보존한다",
);

assert.match(
  buildIndependentReviewSystemPrompt("검수 기준서"),
  /명시적 '선정된'을 completed로 표현한 결과를 수행완료 오분류로 감사하지 마라/,
  "독립 검수자가 창업노트 prior_award 상태 계약을 공유해야 한다",
);
const independentSystemPrompt = buildIndependentReviewSystemPrompt("검수 기준서");
assert.match(independentSystemPrompt, /source_field: aply_trgt.*list_semantics=open/);
assert.match(independentSystemPrompt, /biz_enyy.*비제한 검색 메타데이터/);
assert.match(independentSystemPrompt, /source_field: supt_regin.*region criterion을 만들지 마라/);
assert.match(independentSystemPrompt, /서로 다른 22축이 섞인 대안.*other.*text_only/);
assert.match(independentSystemPrompt, /본 사업 선정 후의 협약 이행.*criterion으로 만들지 말고/);
assert.match(independentSystemPrompt, /중소기업·중견기업·대기업 같은 법정 기업 규모 분류는 size로만/);
assert.match(independentSystemPrompt, /지원대상: 중소기업.*target_type 누락 근거가 아니며.*confirmed_absent/);
assert.match(independentSystemPrompt, /순수 창작물.*현재 또는 과거 수혜 사실이 아니므로|표절·도용 금지/);
assert.match(independentSystemPrompt, /공고명·사업목적·모집안내.*실제 신청기업의 산업 범위다/);
assert.match(independentSystemPrompt, /제출서류 목록은 정보수집·증빙 요구일 뿐/);

const reviewAxes = deriveIndependentReviewAxes({
  runId: "run-unresolved-axis-regression",
  criteria: [{ dimension: "size" }],
  dimensionDiffs: [],
  axisAssessments: CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: dimension === "biz_age"
      ? "ambiguous" as const
      : dimension === "region"
        ? "input_missing" as const
        : dimension === "size"
          ? "condition_found" as const
          : "inspected_no_condition" as const,
    confidence: 0.9,
    comment: null,
  })),
});
assert.equal(reviewAxes.includes("size"), false, "criterion이 있는 축은 빈 축 검수 대상이 아니다");
assert.equal(reviewAxes.includes("biz_age"), false, "ambiguous 축을 누락 결함으로 재판정하지 않는다");
assert.equal(reviewAxes.includes("region"), false, "input_missing 축을 누락 결함으로 재판정하지 않는다");
assert.equal(reviewAxes.includes("target_type"), true, "size가 미해결이어도 별개인 target_type의 조건 없음 판정은 검수한다");
assert.equal(reviewAxes.includes("industry"), true, "실제 조건 없음으로 종결한 축은 전수 검수한다");
assert.equal(reviewAxes.length, CRITERION_DIMENSIONS.length - 3);

assert.throws(
  () => deriveIndependentReviewAxes({
    runId: "run-duplicate-axis",
    criteria: [],
    dimensionDiffs: [],
    axisAssessments: [
      { dimension: "region", status: "ambiguous", confidence: 0.5, comment: null },
      { dimension: "region", status: "input_missing", confidence: 0.5, comment: null },
    ],
  }),
  /독립 검수 축 평가 중복/,
);

assert.deepEqual(normalizeReviewSequences(undefined, [2, 0, 1]), [0, 1, 2]);
assert.deepEqual(normalizeReviewSequences([7, 0, 2], [0, 1, 2, 7]), [0, 2, 7]);
assert.throws(
  () => normalizeReviewSequences([0, 0], [0, 1]),
  /중복 없는 0 이상의 정수/,
);
assert.throws(
  () => normalizeReviewSequences([3], [0, 1]),
  /receipt에 없는 sequence/,
);

console.log("independent-review-packet tests passed");
