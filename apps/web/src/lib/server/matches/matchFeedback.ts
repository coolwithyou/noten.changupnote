import {
  CRITERION_DIMENSIONS,
  ELIGIBILITIES,
} from "@cunote/contracts";
import type {
  CriterionDimension,
  CriterionResult,
  Eligibility,
  FeedbackKind,
  FeedbackReceipt,
  FeedbackResult,
  MatchFeedbackCorrection,
  MatchFeedbackReasonCode,
  MatchFeedbackRequest,
  MatchOutcome,
} from "@cunote/contracts";
import type { SubmitFeedbackInput } from "@cunote/core";

const FEEDBACK_KINDS: FeedbackKind[] = [
  "saved",
  "dismissed",
  "wrong",
  "applied",
  "selected",
  "rejected",
  "blocked",
  "note",
];
const OUTCOMES: MatchOutcome[] = ["pending", "selected", "rejected", "blocked"];
const REASON_CODES: MatchFeedbackReasonCode[] = [
  "wrong_high",
  "wrong_low",
  "wrong_condition",
  "profile_wrong",
  "criteria_wrong",
  "taxonomy_gap",
  "portal_blocked",
  "selected",
  "rejected",
  "other",
];
const CRITERION_RESULTS: CriterionResult[] = ["pass", "fail", "unknown"];

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
    reasonCode: normalizeReasonCode(input.body.reasonCode),
    outcome: normalizeOutcome(input.body.outcome),
    occurredAt: normalizeDateTime(input.body.occurredAt),
    correction: normalizeCorrection(input.body.correction),
    payload: normalizePayload(input.body.payload),
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

function normalizeReasonCode(value: unknown): MatchFeedbackReasonCode | null {
  return REASON_CODES.includes(value as MatchFeedbackReasonCode) ? value as MatchFeedbackReasonCode : null;
}

function normalizeOutcome(value: unknown): MatchOutcome | null {
  return OUTCOMES.includes(value as MatchOutcome) ? value as MatchOutcome : null;
}

function normalizeCorrection(value: unknown): MatchFeedbackCorrection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const correction: MatchFeedbackCorrection = {};
  const dimension = normalizeDimension(record.dimension);
  const expectedEligibility = normalizeEligibility(record.expectedEligibility);
  const correctedEligibility = normalizeEligibility(record.correctedEligibility);
  const correctedResult = normalizeCriterionResult(record.correctedResult);
  const criterionId = normalizeOptionalString(record.criterionId);
  const note = normalizeOptionalString(record.note);

  if (dimension) correction.dimension = dimension;
  if (criterionId !== null) correction.criterionId = criterionId;
  if (expectedEligibility) correction.expectedEligibility = expectedEligibility;
  if (correctedEligibility) correction.correctedEligibility = correctedEligibility;
  if (correctedResult) correction.correctedResult = correctedResult;
  if (note !== null) correction.note = note;

  return Object.keys(correction).length > 0 ? correction : null;
}

function normalizeDimension(value: unknown): CriterionDimension | null {
  return (CRITERION_DIMENSIONS as readonly string[]).includes(value as string)
    ? value as CriterionDimension
    : null;
}

function normalizeEligibility(value: unknown): Eligibility | null {
  return (ELIGIBILITIES as readonly string[]).includes(value as string) ? value as Eligibility : null;
}

function normalizeCriterionResult(value: unknown): CriterionResult | null {
  return CRITERION_RESULTS.includes(value as CriterionResult) ? value as CriterionResult : null;
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
