import type { FeedbackKind, FeedbackReceipt, FeedbackResult, MatchFeedbackRequest } from "@cunote/contracts";
import type { SubmitFeedbackInput } from "@cunote/core";

const FEEDBACK_KINDS: FeedbackKind[] = ["saved", "dismissed", "wrong", "applied", "note"];

export async function readMatchFeedbackRequest(request: Request): Promise<MatchFeedbackRequest> {
  try {
    const parsed = await request.json() as MatchFeedbackRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function buildSubmitFeedbackInput(input: {
  companyId: string;
  grantId: string;
  body: MatchFeedbackRequest;
  userId?: string;
}): SubmitFeedbackInput {
  const feedbackInput: SubmitFeedbackInput = {
    companyId: input.companyId,
    grantId: input.grantId,
    kind: normalizeFeedbackKind(input.body.kind),
    message: input.body.message ?? null,
  };
  if (input.userId) feedbackInput.userId = input.userId;
  return feedbackInput;
}

export function buildFeedbackResult(receipt: FeedbackReceipt): FeedbackResult {
  return { receipt };
}

export function decodeGrantIdSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFeedbackKind(value: unknown): FeedbackKind {
  return FEEDBACK_KINDS.includes(value as FeedbackKind) ? value as FeedbackKind : "note";
}
