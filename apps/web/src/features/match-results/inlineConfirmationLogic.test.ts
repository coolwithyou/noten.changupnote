import assert from "node:assert/strict";
import type { GrantConfirmationSubmitResult, GrantConfirmationsResult, MatchCard } from "@cunote/contracts";
import {
  inlineConfirmationEndpoint,
  inlineConfirmationOutcome,
  selectInlineConfirmationQuestion,
} from "./inlineConfirmationLogic";

const binding = {
  contractVersion: "confirmation-evaluation-v2" as const,
  criterionId: "criterion-1",
  sourceRevisionSha256: "a".repeat(64),
  sourceRawSha256: "b".repeat(64),
  definitionSha256: "c".repeat(64),
  questionVersion: 2,
};
const result: GrantConfirmationsResult = {
  grantId: "grant-1",
  canSubmit: true,
  questions: [{
    id: "q-hard",
    prompt: "선정되면 사업장을 이전할 수 있나요?",
    answerType: "single",
    options: [
      { value: "yes", label: "네, 가능해요" },
      { value: "no", label: "어려워요" },
      { value: "unknown", label: "잘 모르겠어요", isUnknown: true },
    ],
    binding,
  }, {
    id: "q-preferred",
    prompt: "우대 조건도 확인할까요?",
    answerType: "single",
    options: [{ value: "yes", label: "네" }, { value: "no", label: "아니요" }],
    binding: { ...binding, criterionId: "preferred", definitionSha256: "d".repeat(64) },
  }],
  answers: [{
    questionId: "q-hard",
    values: ["unknown"],
    evaluation: "unknown",
    answerRevision: 3,
    answeredAt: "2026-09-21T00:00:00.000Z",
  }],
};

const selected = selectInlineConfirmationQuestion(result, "q-hard");
assert.equal(selected.status, "ready", "추가 우대 질문이 있어도 exact hard question id를 선택한다");
if (selected.status === "ready") {
  assert.equal(selected.question.id, "q-hard");
  assert.equal(selected.answerRevision, 3);
}
assert.deepEqual(
  selectInlineConfirmationQuestion(result, "missing"),
  { status: "unavailable", reason: "missing" },
);
assert.deepEqual(
  selectInlineConfirmationQuestion({ ...result, canSubmit: false }, "q-hard"),
  { status: "unavailable", reason: "readonly" },
);
const { binding: _binding, ...questionWithoutBinding } = result.questions[0]!;
assert.deepEqual(
  selectInlineConfirmationQuestion({
    ...result,
    questions: [questionWithoutBinding],
  }, "q-hard"),
  { status: "unavailable", reason: "unsupported" },
);
assert.equal(
  inlineConfirmationEndpoint("grant/한글", "company id"),
  "/api/web/matches/grant%2F%ED%95%9C%EA%B8%80/confirmations?companyId=company+id",
);

const submitted = (match: MatchCard | null, status: GrantConfirmationSubmitResult["refresh"]["status"] = "succeeded") => ({
  grantId: "grant-1",
  saved: [],
  match,
  refresh: { plannedCount: 1, savedCount: status === "failed" ? 0 : 1, status },
}) satisfies GrantConfirmationSubmitResult;
const eligibleMatch = {
  grantId: "grant-1",
  eligibility: "eligible",
  recommendationTier: "recommendable",
} as MatchCard;
assert.match(inlineConfirmationOutcome(submitted(eligibleMatch)).title, /지원 조건에 맞아요/);
assert.deepEqual(
  {
    action: inlineConfirmationOutcome(submitted(eligibleMatch)).action,
    actionLabel: inlineConfirmationOutcome(submitted(eligibleMatch)).actionLabel,
  },
  { action: "prepare", actionLabel: "신청 준비하기" },
);
assert.match(inlineConfirmationOutcome(submitted({
  ...eligibleMatch,
  eligibility: "ineligible",
  recommendationTier: "not_recommended",
})).title, /맞지 않는/);
assert.equal(inlineConfirmationOutcome(submitted({
  ...eligibleMatch,
  eligibility: "ineligible",
  recommendationTier: "not_recommended",
})).action, "continue");
assert.match(inlineConfirmationOutcome(submitted({
  ...eligibleMatch,
  eligibility: "conditional",
  recommendationTier: "needs_profile_input",
})).detail, /추가로 확인/);
assert.equal(
  inlineConfirmationOutcome(submitted(null, "failed")).actionLabel,
  "최신 결과 다시 불러오기",
);
assert.equal(inlineConfirmationOutcome(submitted(null, "failed")).action, "refresh");

console.log("inline grant confirmation logic: exact question selection and fail-closed guards passed");
