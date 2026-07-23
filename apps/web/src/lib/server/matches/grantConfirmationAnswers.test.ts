import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import { applyConfirmationQuestionCounts } from "./annotateConfirmationQuestions";
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

/* ── 답변 검증: 소속·부분집합·single 1개·중복 규칙 ── */

const singleQuestion: ConfirmationQuestionRecord = {
  id: "q-single",
  answerType: "single",
  options: [
    { value: "none", label: "해당 없음", disqualifies: false },
    { value: "arrears", label: "체납 중", disqualifies: true },
  ],
};
const multiQuestion: ConfirmationQuestionRecord = {
  id: "q-multi",
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

const cards = [card("11111111-1111-1111-8111-111111111111"), card("22222222-2222-1222-8222-222222222222")];
const untouched = applyConfirmationQuestionCounts(cards, new Map());
assert.equal(untouched, cards, "빈 집계는 입력 배열을 그대로 반환해야 한다");
assert.equal(untouched[0]?.confirmationQuestionCount, undefined);

const annotated = applyConfirmationQuestionCounts(
  cards,
  new Map([
    ["11111111-1111-1111-8111-111111111111", 3],
    ["33333333-3333-1333-8333-333333333333", 5],
  ]),
);
assert.equal(annotated[0]?.confirmationQuestionCount, 3);
assert.equal(annotated[1]?.confirmationQuestionCount, undefined, "집계에 없는 공고는 필드를 싣지 않는다");

console.log("grant-confirmation-answers: ok");

function failCode(result: ReturnType<typeof validateConfirmationAnswers>): string | null {
  return result.ok ? null : result.code;
}

function card(grantId: string): MatchCard {
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
    ruleTrace: [],
  } as unknown as MatchCard;
}
