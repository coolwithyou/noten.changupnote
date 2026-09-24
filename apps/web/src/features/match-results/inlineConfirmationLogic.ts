import type {
  GrantConfirmationQuestionDto,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
} from "@cunote/contracts";

export type InlineQuestionState =
  | {
      status: "ready";
      question: GrantConfirmationQuestionDto;
      answerRevision: number;
      companyFactRevision: string | null;
    }
  | { status: "unavailable"; reason: "missing" | "unsupported" | "readonly" };

export function selectInlineConfirmationQuestion(
  result: GrantConfirmationsResult,
  questionId: string,
): InlineQuestionState {
  const question = result.questions.find((candidate) => candidate.id === questionId);
  if (!question) return { status: "unavailable", reason: "missing" };
  if (question.answerType !== "single" || question.options.length < 2 || !question.binding) {
    return { status: "unavailable", reason: "unsupported" };
  }
  if (!result.canSubmit) return { status: "unavailable", reason: "readonly" };
  const answer = result.answers.find((candidate) => candidate.questionId === questionId);
  return {
    status: "ready",
    question,
    answerRevision: answer?.answerRevision ?? 0,
    companyFactRevision: answer?.companyFactRevision ?? null,
  };
}

export function inlineConfirmationEndpoint(grantId: string, companyId: string): string {
  const query = new URLSearchParams({ companyId });
  return `/api/web/matches/${encodeURIComponent(grantId)}/confirmations?${query.toString()}`;
}

export type InlineConfirmationOutcome = {
  title: string;
  detail: string;
  actionLabel: string;
  action: "prepare" | "refresh" | "continue";
};

/** 저장 성공과 최신 판정 반영을 분리해 사용자가 같은 카드에서 결과를 먼저 읽게 한다. */
export function inlineConfirmationOutcome(
  result: GrantConfirmationSubmitResult,
): InlineConfirmationOutcome {
  if (!result.match || result.refresh.status === "failed" || result.refresh.status === "stale") {
    return {
      title: "답변을 저장했어요.",
      detail: "최신 지원 가능 여부를 다시 불러와야 해요.",
      actionLabel: "최신 결과 다시 불러오기",
      action: "refresh",
    };
  }
  const relatedDetail = result.refresh.plannedCount > 1
    ? `같은 회사 정보를 쓰는 공고 ${result.refresh.plannedCount}건도 함께 다시 확인했어요.`
    : null;
  if (result.match.eligibility === "eligible" && result.match.recommendationTier === "recommendable") {
    return {
      title: "확인된 지원 조건에 맞아요.",
      detail: relatedDetail ?? "이 공고의 신청 방법과 준비 항목을 바로 확인할 수 있어요.",
      actionLabel: "신청 준비하기",
      action: "prepare",
    };
  }
  if (result.match.eligibility === "ineligible") {
    return {
      title: "현재 조건과 맞지 않는 항목이 확인됐어요.",
      detail: relatedDetail ?? "결과에 반영하면 불일치 근거와 다른 공고를 계속 확인할 수 있어요.",
      actionLabel: "다른 공고 계속 보기",
      action: "continue",
    };
  }
  return {
    title: "답변을 저장했어요.",
    detail: relatedDetail ?? "추가로 확인할 조건이 남아 있어요. 최신 판정을 결과에 반영해 주세요.",
    actionLabel: "최신 결과에 반영하기",
    action: "continue",
  };
}
