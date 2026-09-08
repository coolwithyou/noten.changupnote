import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import {
  applyActionableConfirmationQuestions,
  matchingQuestionBinding,
  type ConfirmationQuestionAnchor,
} from "./annotateConfirmationQuestions";
import {
  normalizeConfirmationAnswerType,
  normalizeConfirmationOptions,
  readAnswerValues,
  validateConfirmationAnswers,
  type ConfirmationQuestionRecord,
} from "./grantConfirmationAnswers";

/* ── 옵션 정규화: value/label 문자열 아닌 항목은 버리고 disqualifies 는 true 명시일 때만 ── */

const options = normalizeConfirmationOptions([
  { value: "none", label: "해당 없음" },
  { value: "arrears", label: "체납 중이에요", disqualifies: true },
  { value: "bad", label: 3 },
  { label: "value 없음" },
  "not-an-object",
  { value: "weird", label: "극성 오염", disqualifies: "yes" },
]);
assert.deepEqual(options.map((option) => option.value), ["none", "arrears", "weird"]);
assert.deepEqual(options.map((option) => option.disqualifies), [false, true, false]);

assert.equal(normalizeConfirmationAnswerType("multi"), "multi");
assert.equal(normalizeConfirmationAnswerType("single"), "single");
assert.equal(normalizeConfirmationAnswerType("something-else"), "single");

const matchingBindingRow = {
  grantId: "00000000-0000-4000-8000-000000000001",
  criterionId: "00000000-0000-4000-8000-000000000002",
  evaluationContractVersion: "confirmation-evaluation-v2",
  sourceRevisionSha256: "a".repeat(64),
  sourceRawSha256: "b".repeat(64),
  answerType: "single",
  options: [
    { value: "yes", label: "예", evaluation: "satisfied" },
    { value: "no", label: "아니오", evaluation: "unsatisfied" },
    { value: "unknown", label: "모름", evaluation: "unknown" },
  ],
  reusable: "per_notice",
  provenance: {
    runId: "run-current",
    auditState: "analysis_launch_independent_review",
    criterionIndex: 0,
  },
  needsReview: false,
  sourceSpan: "지원 시점 조건 확인",
};
const servingRuns = new Map([[matchingBindingRow.grantId, new Set(["run-current"])]]);
const currentSources = new Map([[matchingBindingRow.grantId, {
  sourceRevisionSha256: matchingBindingRow.sourceRevisionSha256,
  sourceRawSha256: matchingBindingRow.sourceRawSha256,
}]]);
assert.equal(
  matchingQuestionBinding(matchingBindingRow, servingRuns, currentSources)?.evaluationKind,
  "three_state_single",
);
assert.equal(
  matchingQuestionBinding({ ...matchingBindingRow, answerType: "multi" }, servingRuns, currentSources),
  null,
);
assert.equal(
  matchingQuestionBinding({ ...matchingBindingRow, needsReview: true }, servingRuns, currentSources),
  null,
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    provenance: { ...matchingBindingRow.provenance, auditState: "ai_audit_concur" },
  }, servingRuns, currentSources),
  null,
);
assert.equal(
  matchingQuestionBinding(
    matchingBindingRow,
    new Map([[matchingBindingRow.grantId, new Set(["run-old"])]]),
    currentSources,
  ),
  null,
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    options: matchingBindingRow.options.slice(0, 2),
  }, servingRuns, currentSources),
  null,
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    options: [
      ...matchingBindingRow.options,
      { value: "invalid", label: 3, evaluation: "satisfied" },
    ],
  }, servingRuns, currentSources),
  null,
  "오염 옵션을 버린 뒤 남은 3개로 readiness를 열지 않는다",
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    options: [
      ...matchingBindingRow.options.slice(0, 2),
      { value: "yes", label: "중복 값", evaluation: "unknown" },
    ],
  }, servingRuns, currentSources),
  null,
  "서로 다른 의미가 같은 option value를 공유하면 거부한다",
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    options: [
      ...matchingBindingRow.options.slice(0, 2),
      { value: "   ", label: "모름", evaluation: "unknown" },
    ],
  }, servingRuns, currentSources),
  null,
  "공백 option value는 거부한다",
);
assert.equal(
  matchingQuestionBinding({
    ...matchingBindingRow,
    provenance: { ...matchingBindingRow.provenance, criterionIndex: -1 },
  }, servingRuns, currentSources),
  null,
  "음수 criterion index는 원본 criterion 결속으로 쓰지 않는다",
);
assert.equal(
  matchingQuestionBinding(matchingBindingRow, servingRuns, new Map([[matchingBindingRow.grantId, {
    sourceRevisionSha256: "c".repeat(64),
    sourceRawSha256: matchingBindingRow.sourceRawSha256,
  }]])),
  null,
);

/* ── 답변 검증: 소속·부분집합·single 1개·중복 규칙 ── */

const singleQuestion: ConfirmationQuestionRecord = {
  id: "q-single",
  kind: "exclusion",
  answerType: "single",
  options: [
    { value: "none", label: "해당 없음", disqualifies: false },
    { value: "arrears", label: "체납 중", disqualifies: true },
  ],
};
const multiQuestion: ConfirmationQuestionRecord = {
  id: "q-multi",
  kind: "exclusion",
  answerType: "multi",
  options: [
    { value: "a", label: "A", disqualifies: false },
    { value: "b", label: "B", disqualifies: false },
    { value: "c", label: "C", disqualifies: true },
  ],
};
const questions = [singleQuestion, multiQuestion];

// 빈 제출
assert.deepEqual(
  failCode(validateConfirmationAnswers({ questions, answers: [] })),
  "confirmation_answers_empty",
);
// 공고 밖 질문
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [{ questionId: "q-other", values: ["none"] }],
  })),
  "confirmation_question_not_found",
);
// 같은 질문 중복 제출
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [
      { questionId: "q-single", values: ["none"] },
      { questionId: "q-single", values: ["arrears"] },
    ],
  })),
  "confirmation_answer_duplicated",
);
// 빈 values (건너뛰기는 제출하지 않는 방식이므로 빈 배열은 오류)
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [{ questionId: "q-single", values: [] }],
  })),
  "confirmation_values_empty",
);
// single 에 2개
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [{ questionId: "q-single", values: ["none", "arrears"] }],
  })),
  "confirmation_single_choice_violated",
);
// 옵션 집합 밖 값
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [{ questionId: "q-multi", values: ["a", "z"] }],
  })),
  "confirmation_value_not_in_options",
);
// 같은 선택지 중복
assert.deepEqual(
  failCode(validateConfirmationAnswers({
    questions,
    answers: [{ questionId: "q-multi", values: ["a", "a"] }],
  })),
  "confirmation_value_duplicated",
);

/* ── disqualified 스냅샷: 선택지 중 하나라도 disqualifies=true 면 true ── */

const ok = validateConfirmationAnswers({
  questions,
  answers: [
    { questionId: "q-single", values: ["none"] },
    { questionId: "q-multi", values: ["a", "c"] },
  ],
});
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.deepEqual(ok.answers, [
    { questionId: "q-single", values: ["none"], disqualified: false },
    { questionId: "q-multi", values: ["a", "c"], disqualified: true },
  ]);
}

const cleanMulti = validateConfirmationAnswers({
  questions,
  answers: [{ questionId: "q-multi", values: ["a", "b"] }],
});
assert.equal(cleanMulti.ok, true);
if (cleanMulti.ok) {
  assert.equal(cleanMulti.answers[0]?.disqualified, false);
}

/* ── 저장 행 answer jsonb 복원 ── */

assert.deepEqual(readAnswerValues({ values: ["a", "b"] }), ["a", "b"]);
assert.deepEqual(readAnswerValues({ values: ["a", 1, null] }), ["a"]);
assert.deepEqual(readAnswerValues(null), []);
assert.deepEqual(readAnswerValues(["a"]), []);

/* ── 카드 주석 적용: 빈 집계(빈 테이블 경로)는 카드를 그대로 두고 필드도 싣지 않는다 ── */

const actionableGrantId = "11111111-1111-1111-8111-111111111111";
const blockedGrantId = "22222222-2222-1222-8222-222222222222";
const cards = [
  card(actionableGrantId, [{
    dimension: "prior_award",
    kind: "exclusion",
    result: "unknown",
    label: "동일 사업 수혜 이력",
    sourceSpan: "동일 사업에 선정된 이력이 있는 기업은 제외",
    checklistSection: "needs_check",
    unresolvedReason: "company_profile_missing",
    confirmationNextAction: "company_profile",
  }]),
  card(blockedGrantId, [
    {
      dimension: "other",
      kind: "exclusion",
      result: "text_only",
      label: "허위 정보 제출",
      sourceSpan: "허위 또는 과장된 정보 제출 시 선정 취소",
      checklistSection: "needs_check",
      unresolvedReason: "criterion_text_only",
      confirmationNextAction: "admin_source_review",
    },
    {
      dimension: "industry",
      kind: "required",
      result: "unknown",
      label: "금융 AI 기업",
      sourceSpan: "금융 AI 기업 모집",
      checklistSection: "needs_check",
      unresolvedReason: "company_profile_missing",
      confirmationNextAction: "company_profile",
    },
  ]),
];
const untouched = applyActionableConfirmationQuestions(cards, []);
assert.equal(untouched, cards, "빈 집계는 입력 배열을 그대로 반환해야 한다");
assert.equal(untouched[0]?.confirmationQuestionCount, undefined);

const anchors: ConfirmationQuestionAnchor[] = [
  anchor("q-actionable", actionableGrantId, "prior_award", "동일 사업에 선정된 이력이 있는 기업은 제외"),
  anchor("q-low-value", blockedGrantId, "other", "허위 또는 과장된 정보 제출 시 선정 취소"),
];
const annotated = applyActionableConfirmationQuestions(cards, anchors);
assert.equal(annotated[0]?.confirmationQuestionCount, 1, "모든 hard unknown을 해소하는 질문은 노출한다");
assert.equal(
  annotated[1]?.confirmationQuestionCount,
  1,
  "다른 blocker가 남아도 답할 수 있는 일부 사실부터 확인한다",
);
assert.equal(annotated[1]?.ruleTrace[0]?.confirmationNextAction, "user_confirmation");

const reconfirm = applyActionableConfirmationQuestions([
  { ...cards[0]!, userConfirmedCount: 1, ruleTrace: [] },
], anchors);
assert.equal(reconfirm[0]?.confirmationQuestionCount, 1, "기존 답변이 있으면 재확인 진입을 유지한다");

const preferredGrantId = "33333333-3333-1333-8333-333333333333";
const preferredCriterionId = "criterion-preferred-confirmation";
const preferredCard = card(preferredGrantId, [{
  criterionId: preferredCriterionId,
  dimension: "prior_award",
  kind: "preferred",
  result: "text_only",
  label: "공고별 우대 이력 확인",
  sourceSpan: "해당 이력이 있으면 가점",
  checklistSection: "preferred_miss",
  unresolvedReason: "criterion_text_only",
  confirmationNextAction: "admin_source_review",
}]);
preferredCard.eligibility = "eligible";
preferredCard.bucket = "now";
const preferredAnnotated = applyActionableConfirmationQuestions([preferredCard], [{
  questionId: "q-preferred",
  grantId: preferredGrantId,
  criterionId: preferredCriterionId,
  dimension: "prior_award",
  kind: "preferred",
  operator: "text_only",
  sourceSpan: "해당 이력이 있으면 가점",
}]);
assert.equal(preferredAnnotated[0]?.eligibility, "eligible", "우대 질문은 eligibility를 바꾸지 않는다");
assert.equal(preferredAnnotated[0]?.confirmationQuestionCount, 1);
assert.equal(preferredAnnotated[0]?.ruleTrace[0]?.confirmationNextAction, "user_confirmation");

const protectedGrantId = "44444444-4444-1444-8444-444444444444";
for (const unresolvedReason of ["source_dispute", "criterion_needs_review", "criterion_invalid"] as const) {
  const protectedCriterionId = `criterion-${unresolvedReason}`;
  const protectedCard = card(protectedGrantId, [{
    criterionId: protectedCriterionId,
    dimension: "tax_compliance",
    kind: "exclusion",
    result: "unknown",
    label: "세금 조건 확인",
    sourceSpan: "체납 기업 제외",
    checklistSection: "needs_check",
    unresolvedReason,
    confirmationNextAction: "admin_source_review",
  }]);
  const protectedResult = applyActionableConfirmationQuestions([protectedCard], [{
    questionId: `q-${unresolvedReason}`,
    grantId: protectedGrantId,
    criterionId: protectedCriterionId,
    dimension: "tax_compliance",
    kind: "exclusion",
    operator: "in",
    sourceSpan: "체납 기업 제외",
  }]);
  assert.equal(protectedResult[0]?.confirmationQuestionCount, undefined);
  assert.equal(protectedResult[0]?.ruleTrace[0]?.confirmationNextAction, "admin_source_review");
}

const cleared = applyActionableConfirmationQuestions(preferredAnnotated, []);
assert.equal(cleared[0]?.confirmationQuestionCount, undefined, "질문 조회 결과가 비면 과거 주석 count를 제거한다");
assert.equal(cleared[0]?.ruleTrace[0]?.confirmationNextAction, "admin_source_review", "stale user CTA를 기본 원인으로 되돌린다");
assert.equal(cleared[0]?.eligibility, "eligible");

const legacyUnclassified = card(preferredGrantId, [{
  criterionId: preferredCriterionId,
  dimension: "prior_award",
  kind: "preferred",
  result: "text_only",
  label: "원인 계약 이전 카드",
  sourceSpan: "해당 이력이 있으면 가점",
  checklistSection: "preferred_miss",
}]);
const legacyAnnotated = applyActionableConfirmationQuestions([legacyUnclassified], [{
  questionId: "q-preferred",
  grantId: preferredGrantId,
  criterionId: preferredCriterionId,
  dimension: "prior_award",
  kind: "preferred",
  operator: "text_only",
  sourceSpan: "해당 이력이 있으면 가점",
}]);
assert.equal(legacyAnnotated[0]?.confirmationQuestionCount, undefined, "원인 없는 legacy unknown은 질문으로 추정 승격하지 않는다");

const mixedGrantId = "55555555-5555-1555-8555-555555555555";
const mixedCard = card(mixedGrantId, [
  {
    criterionId: "criterion-already-confirmed",
    dimension: "region",
    kind: "required",
    result: "pass",
    label: "지역 확인 완료",
    checklistSection: "satisfied",
    resolution: "confirmed_by_user",
  },
  {
    criterionId: "criterion-unanswered-preferred",
    dimension: "prior_award",
    kind: "preferred",
    result: "text_only",
    label: "우대 이력 확인",
    checklistSection: "preferred_miss",
    unresolvedReason: "criterion_text_only",
    confirmationNextAction: "admin_source_review",
  },
]);
mixedCard.userConfirmedCount = 1;
const mixedAnnotated = applyActionableConfirmationQuestions([mixedCard], [
  {
    questionId: "q-already-confirmed",
    grantId: mixedGrantId,
    criterionId: "criterion-already-confirmed",
    dimension: "region",
    kind: "required",
    operator: "in",
    sourceSpan: null,
  },
  {
    questionId: "q-unanswered-preferred",
    grantId: mixedGrantId,
    criterionId: "criterion-unanswered-preferred",
    dimension: "prior_award",
    kind: "preferred",
    operator: "text_only",
    sourceSpan: null,
  },
]);
assert.equal(mixedAnnotated[0]?.confirmationQuestionCount, 2, "기존 답변이 있어도 다른 미답변 질문을 함께 보존한다");
assert.equal(mixedAnnotated[0]?.ruleTrace[1]?.confirmationNextAction, "user_confirmation");

/* ── v2 명시 3상태: 단일 선택·정확한 binding·revision, 문구 추론 없음 ── */

const binding = {
  contractVersion: "confirmation-evaluation-v2" as const,
  criterionId: "00000000-0000-4000-8000-000000000222",
  sourceRevisionSha256: "a".repeat(64),
  sourceRawSha256: "b".repeat(64),
  definitionSha256: "c".repeat(64),
  questionVersion: 2,
};
const v2Question: ConfirmationQuestionRecord = {
  id: "q-v2",
  kind: "required",
  answerType: "single",
  binding,
  options: normalizeConfirmationOptions([
    { value: "yes", label: "예", evaluation: "satisfied" },
    { value: "no", label: "아니요", evaluation: "unsatisfied" },
    { value: "unknown", label: "확인할 수 없음", evaluation: "unknown" },
  ], binding.contractVersion),
};
for (const [value, evaluation] of [
  ["yes", "satisfied"],
  ["no", "unsatisfied"],
  ["unknown", "unknown"],
] as const) {
  const result = validateConfirmationAnswers({
    questions: [v2Question],
    answers: [{ questionId: v2Question.id, values: [value], binding, expectedAnswerRevision: 0 }],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.answers[0]?.evaluation, evaluation);
}
assert.equal(normalizeConfirmationOptions([
  { value: "yes", label: "예" },
], binding.contractVersion).length, 0, "v2 missing evaluation을 false/pass로 정규화하지 않는다");
assert.equal(failCode(validateConfirmationAnswers({
  questions: [v2Question],
  answers: [{ questionId: v2Question.id, values: ["yes"], binding }],
})), "confirmation_answer_revision_required");
assert.equal(failCode(validateConfirmationAnswers({
  questions: [v2Question],
  answers: [{
    questionId: v2Question.id,
    values: ["yes"],
    binding: { ...binding, sourceRawSha256: "d".repeat(64) },
    expectedAnswerRevision: 0,
  }],
})), "confirmation_question_stale");

console.log("grant-confirmation-answers: ok");

function failCode(result: ReturnType<typeof validateConfirmationAnswers>): string | null {
  return result.ok ? null : result.code;
}

function card(grantId: string, ruleTrace: MatchCard["ruleTrace"]): MatchCard {
  return {
    grantId,
    source: "bizinfo",
    sourceId: "test-grant",
    title: "테스트 공고",
    status: "open",
    eligibility: "conditional",
    bucket: "conditional",
    fitScore: 50,
    writeSupport: "unknown",
    ruleTrace,
  } as unknown as MatchCard;
}

function anchor(
  questionId: string,
  grantId: string,
  dimension: ConfirmationQuestionAnchor["dimension"],
  sourceSpan: string,
): ConfirmationQuestionAnchor {
  return {
    questionId,
    grantId,
    criterionId: `criterion-${questionId}`,
    dimension,
    kind: "exclusion",
    operator: dimension === "prior_award" ? "exists" : "text_only",
    sourceSpan,
  };
}
