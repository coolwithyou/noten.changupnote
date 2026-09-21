import type { MatchCard, RuleTraceChip } from "@cunote/contracts";

export type MatchConfirmationReadiness = {
  /**
   * `one_question_away` is a display promise with a deliberately narrow proof:
   * one active, criterion-bound self-confirmation is the only unresolved hard
   * gate. It does not change matcher eligibility or answer authority.
   */
  status: "one_question_away" | "not_one_question_away";
  /** The criterion whose active question may resolve the last hard gate. */
  representativeCriterionId: string | null;
  /**
   * Exact eligibility-question ids are supplied by the server annotation. A card
   * may also contain preferred questions, which do not replace this id.
   */
  representativeQuestionId: string | null;
  /** No prompt/options/binding is duplicated here; P2 must retrieve these ids through the existing GET. */
  activeQuestionIds: string[];
  /** Criterion ids are kept distinct; dimensions are intentionally never deduplicated here. */
  hardQuestionCriterionIds: string[];
  /** A source/core-review blocker means a user answer cannot make the promise. */
  hasAdditionalReview: boolean;
};

/**
 * Projects the existing matcher result plus server question annotation into the
 * only display state that may say "one question remains". This consumes the
 * exact-criterion `user_confirmation` annotation; it never infers a question
 * from a dimension or from `confirmationQuestionCount` alone.
 *
 * The card carries only exact active question ids. Callers still load prompt,
 * options, binding, and answer revision through the authenticated confirmation
 * resource before rendering or submitting an answer.
 */
export function projectMatchConfirmationReadiness(match: Pick<MatchCard,
  "status" | "eligibility" | "recommendationTier" | "matchingEvidence" |
  "criteriaExtracted" | "ruleTrace" | "confirmationQuestionCount" | "confirmationQuestionIds" |
  "confirmationEligibilityQuestionIds"
>): MatchConfirmationReadiness {
  const hard = match.ruleTrace.filter(isHardCondition);
  const unresolvedHard = hard.filter(isPendingCondition);
  const userQuestions = unresolvedHard.filter(
    (trace) => trace.confirmationNextAction === "user_confirmation",
  );
  const hardBlockers = unresolvedHard.filter(
    (trace) => trace.confirmationNextAction !== "user_confirmation",
  );
  const hardFail = hard.some((trace) => trace.result === "fail");
  const suppliedQuestionIds = match.confirmationQuestionIds ?? [];
  const activeQuestionIds = [...new Set(suppliedQuestionIds)].sort();
  const suppliedEligibilityQuestionIds = match.confirmationEligibilityQuestionIds ?? [];
  const activeEligibilityQuestionIds = [...new Set(suppliedEligibilityQuestionIds)].sort();
  const hasConsistentActiveQuestionAnnotation =
    activeQuestionIds.length > 0
    && suppliedQuestionIds.length === activeQuestionIds.length
    && match.confirmationQuestionCount === activeQuestionIds.length
    && activeEligibilityQuestionIds.length === userQuestions.length
    && suppliedEligibilityQuestionIds.length === activeEligibilityQuestionIds.length
    && activeEligibilityQuestionIds.every((id) => activeQuestionIds.includes(id));
  const hasAdditionalReview =
    match.recommendationTier === "needs_core_review"
    || hardBlockers.length > 0
    || match.criteriaExtracted === false;
  const candidateCriterionId = userQuestions.length === 1
    ? userQuestions[0]?.criterionId ?? null
    : null;
  // The current production matcher combines required/exclusion traces as hard
  // gates. A reviewed v2 question always has an explicit `satisfied` option;
  // simulate that result here and require every hard gate to pass. This keeps
  // the display promise tied to matcher behavior instead of trace cardinality.
  const satisfiedAnswerWouldResolveEligibility = candidateCriterionId !== null
    && hard.every((trace) => (
      trace.criterionId === candidateCriterionId
      && isPendingCondition(trace)
      && trace.confirmationNextAction === "user_confirmation"
        ? true
        : trace.result === "pass"
    ));
  const isOneQuestionAway =
    match.status === "open"
    && match.eligibility === "conditional"
    // Verified-only serving omits the evidence envelope after filtering. The
    // exact active-question annotation below is still bound to the current
    // reviewed source revision; only an explicit discovery card is unsafe.
    && match.matchingEvidence?.level !== "discovery"
    && match.recommendationTier === "needs_profile_input"
    // Count and ids prove the action came through one consistent active-question
    // annotation, but neither is used to count or collapse hard conditions.
    && hasConsistentActiveQuestionAnnotation
    && satisfiedAnswerWouldResolveEligibility
    && !hardFail
    && !hasAdditionalReview
    && userQuestions.length === 1;
  const hardQuestionCriterionIds = userQuestions.flatMap((trace) =>
    trace.criterionId ? [trace.criterionId] : []);
  return {
    status: isOneQuestionAway ? "one_question_away" : "not_one_question_away",
    representativeCriterionId: isOneQuestionAway
      ? hardQuestionCriterionIds[0] ?? null
      : null,
    representativeQuestionId: isOneQuestionAway && activeEligibilityQuestionIds.length === 1
      ? activeEligibilityQuestionIds[0] ?? null
      : null,
    activeQuestionIds,
    hardQuestionCriterionIds,
    hasAdditionalReview,
  };
}

/** 표시 전용 projection. 자격 판정이나 질문 권한을 새로 만들지 않는다. */
export function explainMatch(match: Pick<MatchCard,
  "status" | "eligibility" | "recommendationTier" | "matchingEvidence" |
  "criteriaExtracted" | "ruleTrace" | "reviewReasons" | "confirmationQuestionCount" |
  "confirmationQuestionIds" | "confirmationEligibilityQuestionIds"
>) {
  const discovery = match.matchingEvidence?.level === "discovery";
  const conditions = discovery ? [] : match.ruleTrace
    .filter((trace) => trace.kind === "required" || trace.kind === "exclusion")
    .map(explainCondition);
  const passed = conditions.filter((condition) => condition.trace.result === "pass").length;
  const failed = conditions.filter((condition) => condition.trace.result === "fail").length;
  const pending = conditions.filter((condition) => condition.pending);
  const profile = pending.filter((condition) => condition.action === "company_profile");
  const confirmation = pending.filter((condition) => condition.action === "user_confirmation");
  const source = pending.filter((condition) => condition.action === "admin_source_review");
  const userCheckableSource = source.filter((condition) => condition.asksUser);
  const coreReview = match.recommendationTier === "needs_core_review";
  const reviewNotes = discovery ? [] : (match.reviewReasons ?? [])
    .filter((reason) => !["profile_missing", "disqualification_unconfirmed", "hard_fail"].includes(reason.code))
    .map((reason) => reason.label);
  const hasSourceBlocker = discovery || coreReview || source.length > 0 || match.criteriaExtracted === false;
  const canConfirm = (match.confirmationQuestionCount ?? 0) > 0 && confirmation.length > 0;
  const confirmationReadiness = projectMatchConfirmationReadiness(match);
  const action = match.status !== "open" || match.eligibility === "ineligible"
    ? "details"
    : profile.length > 0 ? "company_profile"
      : canConfirm ? "user_confirmation"
        : hasSourceBlocker || pending.length > 0 ? "source"
          : match.eligibility === "eligible" && match.recommendationTier === "recommendable"
            ? "preparation" : "details";
  const summary = discovery
    ? "지원 조건을 아직 비교하지 못했어요. 공고 원문에서 모집 대상을 확인해 주세요."
    : failed > 0 ? `현재 회사 정보와 맞지 않는 조건이 ${failed}개 있어요.`
      : confirmationReadiness.status === "one_question_away"
        ? "이 질문에 답하면 지원 가능 여부를 바로 다시 확인할 수 있어요."
      : confirmation.length > 0 && profile.length === 0 && confirmation.length === pending.length
        ? confirmation.length === 1
          ? "직접 답할 조건이 1개 있어요. 답변 후 판정을 다시 확인해요."
          : `직접 답할 조건이 ${confirmation.length}개 있어요. 답변 후 판정을 다시 확인해요.`
      : profile.length + confirmation.length > 0
        ? `직접 확인할 조건 ${profile.length + confirmation.length}개${hasSourceBlocker ? " · 별도 공고 조건 확인도 필요해요" : " — 답변에 따라 자격을 다시 판단해요"}`
        : pending.length > 0 && userCheckableSource.length === pending.length
          ? pending.length === 1
            ? "공고 원문에서 직접 확인할 조건이 1개 있어요."
            : `공고 원문에서 직접 확인할 조건이 ${pending.length}개 있어요.`
        : hasSourceBlocker ? "공고에서 확인할 조건이 남아 있어요. 아래 근거를 확인해 주세요."
          : pending.length > 0 ? `아직 확인하지 못한 조건이 ${pending.length}개 있어요.`
            : match.eligibility === "eligible" && match.recommendationTier === "recommendable"
              ? "확인된 자격조건에 맞아요. 신청 방법과 제출 서류를 확인해 보세요."
              : "공고의 지원 조건과 모집 일정을 확인해 주세요.";
  return { conditions, passed, failed, unknown: pending.length, profile, confirmation, source,
    hasSourceBlocker, reviewNotes: [...new Set(reviewNotes)], action, summary, discovery,
    confirmationReadiness };
}

export function explainCondition(trace: RuleTraceChip) {
  const pending = trace.result === "unknown" || trace.result === "text_only";
  const action = pending ? trace.confirmationNextAction ?? "admin_source_review" : null;
  const asksUser = pending
    && trace.unresolvedReason === "criterion_text_only"
    && (action === "user_confirmation" || action === "admin_source_review");
  const reason = !pending ? trace.result === "pass" ? "확인된 조건에 맞아요." : "현재 회사 정보와 조건이 맞지 않아요."
    : trace.unresolvedReason === "source_dispute" ? "회사 공식 정보의 정정 확인이 필요해요."
      : action === "company_profile" ? "이 조건과 비교할 회사 정보가 더 필요해요."
        : action === "user_confirmation" ? "답변하면 지원 가능 여부를 바로 다시 판단해요."
          : trace.unresolvedReason === "criterion_needs_review" ? "창업노트에서 추출한 조건의 검수가 필요해요."
            : trace.unresolvedReason === "criterion_invalid" ? "이 조건을 비교할 수 있는 형태로 해석하지 못했어요."
              : asksUser ? "이 조건을 확인하면 지원 가능 여부를 다시 판단할 수 있어요."
                : "공고 원문 근거를 더 확인해야 정확히 판단할 수 있어요.";
  const rawCompanyValue = trace.companyValue?.trim() ?? "";
  return { trace, pending, action, asksUser, reason,
    // 원문 구절을 우선한다. 서술형 조건의 OR/예외 문맥을 label 요약으로 잃지 않는다.
    requirement: trace.sourceSpan?.trim() || trace.label?.trim() || "조건의 원문 근거가 필요해요",
    companyValue: rawCompanyValue || "비교할 회사 정보가 표시되지 않았어요",
    hasCompanyValue: rawCompanyValue.length > 0,
    statusLabel: trace.result === "pass" ? "충족 확인" : trace.result === "fail" ? "미충족" : "확인 필요",
  };
}

function isHardCondition(trace: RuleTraceChip): boolean {
  return trace.kind === "required" || trace.kind === "exclusion";
}

function isPendingCondition(trace: RuleTraceChip): boolean {
  return trace.result === "unknown" || trace.result === "text_only";
}
