export type MatchFeedbackReviewDecisionValue = "accepted" | "rejected";

export interface MatchFeedbackReviewDecision {
  schemaVersion: "matching-feedback-review-v1";
  feedbackId: string;
  decision: MatchFeedbackReviewDecisionValue;
  reviewerId: string;
  reviewedAt: string;
  note: string;
}

export interface ReviewableMatchFeedback {
  id: string;
  actor: "user" | "reviewer";
  targetId: string;
  timestamp: string;
  value: Record<string, unknown>;
}

export interface MatchFeedbackReviewPublicationPlan {
  targetId: string;
  reviewedFeedbackId: string;
  reviewDecision: MatchFeedbackReviewDecisionValue;
  reviewerId: string;
  reviewedAt: string;
  note: string;
  grantRevision: string;
  evaluationCandidate: boolean;
  refreshScope: "none" | "pair" | "company" | "grant" | "manual";
  refreshReason: string;
}

export function parseMatchFeedbackReviewJsonl(
  text: string,
  sourceName = "match-feedback-reviews.jsonl",
): MatchFeedbackReviewDecision[] {
  const decisions = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${sourceName}:${index + 1}: invalid JSON`);
    }
    return parseDecision(value, `${sourceName}:${index + 1}`);
  });
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.feedbackId)) throw new Error(`${sourceName}: duplicate feedbackId ${decision.feedbackId}`);
    seen.add(decision.feedbackId);
  }
  return decisions;
}

export function planMatchFeedbackReviewPublication(input: {
  decision: MatchFeedbackReviewDecision;
  feedback: ReviewableMatchFeedback;
  currentGrantRevision: string;
}): MatchFeedbackReviewPublicationPlan {
  const { decision, feedback } = input;
  if (feedback.actor !== "user") throw new Error(`${decision.feedbackId}: only user feedback is reviewable`);
  if (feedback.id !== decision.feedbackId) throw new Error(`${decision.feedbackId}: feedback id mismatch`);
  const feedbackAt = validIso(feedback.timestamp, `${decision.feedbackId}: feedback timestamp`);
  const reviewedAt = validIso(decision.reviewedAt, `${decision.feedbackId}: reviewedAt`);
  if (new Date(reviewedAt).getTime() < new Date(feedbackAt).getTime()) {
    throw new Error(`${decision.feedbackId}: reviewedAt must not precede feedback timestamp`);
  }
  const submitterId = stringValue(feedback.value.userId);
  if (submitterId && identityKey(submitterId) === identityKey(decision.reviewerId)) {
    throw new Error(`${decision.feedbackId}: reviewer must differ from feedback submitter`);
  }
  if (isLikelyAiIdentity(decision.reviewerId)) {
    throw new Error(`${decision.feedbackId}: reviewerId must identify a human reviewer`);
  }
  const kind = stringValue(feedback.value.kind);
  if (kind !== "wrong" && !isRecord(feedback.value.correction)) {
    throw new Error(`${decision.feedbackId}: feedback is not a correction/review candidate`);
  }
  const provenance = isRecord(feedback.value.provenance) ? feedback.value.provenance : null;
  if (stringValue(provenance?.captureStatus) !== "complete") {
    throw new Error(`${decision.feedbackId}: complete provenance is required`);
  }
  const reviewedRevision = stringValue(provenance?.grantRevision);
  const currentRevision = stringValue(input.currentGrantRevision);
  if (!reviewedRevision || !currentRevision || reviewedRevision !== currentRevision) {
    throw new Error(`${decision.feedbackId}: stale grant revision`);
  }
  return {
    targetId: requiredString(feedback.targetId, `${decision.feedbackId}: targetId`),
    reviewedFeedbackId: decision.feedbackId,
    reviewDecision: decision.decision,
    reviewerId: decision.reviewerId,
    reviewedAt,
    note: decision.note,
    grantRevision: reviewedRevision,
    evaluationCandidate: decision.decision === "accepted",
    ...planRefreshScope(decision.decision, feedback.value),
  };
}

export function planReviewedFeedbackRefresh(value: Record<string, unknown>): {
  refreshScope: MatchFeedbackReviewPublicationPlan["refreshScope"];
  refreshReason: string;
} {
  return planRefreshScope("accepted", value);
}

function planRefreshScope(
  decision: MatchFeedbackReviewDecisionValue,
  value: Record<string, unknown>,
): Pick<MatchFeedbackReviewPublicationPlan, "refreshScope" | "refreshReason"> {
  if (decision !== "accepted") return { refreshScope: "none", refreshReason: "review_rejected" };
  const reasonCode = stringValue(value.reasonCode);
  if (reasonCode === "criteria_wrong" || reasonCode === "missing_condition" || reasonCode === "stale_grant" || reasonCode === "duplicate_grant") {
    return { refreshScope: "grant", refreshReason: reasonCode };
  }
  if (reasonCode === "profile_wrong" || reasonCode === "wrong_company_fact") {
    return { refreshScope: "company", refreshReason: reasonCode };
  }
  if (reasonCode === "taxonomy_gap") {
    return { refreshScope: "manual", refreshReason: reasonCode };
  }
  if (reasonCode === "portal_blocked" || reasonCode === "selected" || reasonCode === "rejected" ||
    reasonCode === "accepted_for_review" || reasonCode === "rejected_at_eligibility") {
    return { refreshScope: "none", refreshReason: reasonCode };
  }
  return { refreshScope: "pair", refreshReason: reasonCode ?? "accepted_correction" };
}

function parseDecision(value: unknown, location: string): MatchFeedbackReviewDecision {
  if (!isRecord(value)) throw new Error(`${location}: record must be an object`);
  if (value.schemaVersion !== "matching-feedback-review-v1") throw new Error(`${location}: invalid schemaVersion`);
  if (value.decision !== "accepted" && value.decision !== "rejected") throw new Error(`${location}: invalid decision`);
  const reviewerId = requiredString(value.reviewerId, `${location}.reviewerId`);
  if (isLikelyAiIdentity(reviewerId)) throw new Error(`${location}: reviewerId must identify a human reviewer`);
  return {
    schemaVersion: "matching-feedback-review-v1",
    feedbackId: requiredString(value.feedbackId, `${location}.feedbackId`),
    decision: value.decision,
    reviewerId,
    reviewedAt: validIso(value.reviewedAt, `${location}.reviewedAt`),
    note: requiredString(value.note, `${location}.note`),
  };
}

function requiredString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`${label} is required`);
  return parsed;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validIso(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid ISO date`);
  return date.toISOString();
}
function identityKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
function isLikelyAiIdentity(value: string): boolean {
  return /(^|[^a-z])(ai|llm|gpt|claude|codex|gemini|anthropic|openai)([^a-z]|$)/i.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
