import {
  CRITERION_DIMENSIONS,
  ELIGIBILITIES,
} from "@cunote/contracts";
import { createHash } from "node:crypto";
import type {
  CompanyProfile,
  CriterionDimension,
  CriterionResult,
  Eligibility,
  FeedbackKind,
  FeedbackReceipt,
  FeedbackResult,
  MatchFeedbackCorrection,
  MatchFeedbackReasonCode,
  MatchFeedbackRequest,
  MatchFeedbackProvenance,
  MatchOutcome,
  NormalizedGrant,
} from "@cunote/contracts";
import { resolveGrantExtractionManifest } from "@cunote/core";
import type { ServiceRepositories, SubmitFeedbackInput } from "@cunote/core";

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
  "wrong_eligibility",
  "wrong_high",
  "wrong_low",
  "wrong_condition",
  "missing_condition",
  "profile_wrong",
  "wrong_company_fact",
  "criteria_wrong",
  "taxonomy_gap",
  "duplicate_grant",
  "stale_grant",
  "portal_blocked",
  "rejected_at_eligibility",
  "accepted_for_review",
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

export async function attachMatchFeedbackProvenance<TPayload>(
  input: SubmitFeedbackInput,
  repositories: ServiceRepositories<TPayload>,
  profileResolution: {
    profile: CompanyProfile;
    stateScope: "company" | "request" | "user";
    asOf: string;
  } | null,
): Promise<SubmitFeedbackInput> {
  const grant = await repositories.grants.findGrantById(input.grantId);
  if (!grant) return { ...input, provenance: emptyProvenance("grant_missing") };
  if (!profileResolution) return { ...input, provenance: grantOnlyProvenance(grant, "company_missing") };
  const company = profileResolution.profile;
  const match = await repositories.matches.calculateGrantMatch({ company, grant });
  const criterionRefs = match.rule_trace.map((entry) => ({
    criterionId: entry.criterion_id ?? null,
    dimension: entry.dimension,
    kind: entry.kind,
    result: entry.result,
    sourceSpanHash: entry.source_span ? hashValue(entry.source_span) : null,
  }));
  const companyFactRefs = unique(match.rule_trace.map((entry) => entry.dimension)).map((dimension) => {
    const values = match.rule_trace
      .filter((entry) => entry.dimension === dimension && entry.company_value !== undefined)
      .map((entry) => entry.company_value);
    return {
      dimension,
      present: values.some((value) => value !== null && value !== undefined),
      valueHash: values.length > 0 ? hashValue(values) : null,
      confidence: finiteNumber(company.confidence?.[dimension]),
    };
  });
  return {
    ...input,
    provenance: {
      captureStatus: "complete",
      capturedAt: profileResolution.asOf,
      grantSource: grant.grant.source,
      grantSourceId: grant.grant.source_id,
      grantRevision: resolveGrantExtractionManifest(grant).revision,
      rulesetVersion: match.ruleset_ver,
      scoringVersion: match.scoring_ver,
      eligibility: match.eligibility,
      extractionReadiness: match.quality.extractionReadiness,
      evidenceCoverage: match.quality.evidenceCoverage,
      criterionRefs,
      companyFactRefs,
    },
  };
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

function emptyProvenance(status: "grant_missing"): MatchFeedbackProvenance {
  return {
    captureStatus: status,
    capturedAt: new Date().toISOString(),
    grantSource: null,
    grantSourceId: null,
    grantRevision: null,
    rulesetVersion: null,
    scoringVersion: null,
    eligibility: null,
    extractionReadiness: null,
    evidenceCoverage: null,
    criterionRefs: [],
    companyFactRefs: [],
  };
}

function grantOnlyProvenance<TPayload>(
  grant: NormalizedGrant<TPayload>,
  status: "company_missing",
): MatchFeedbackProvenance {
  return {
    ...emptyProvenance("grant_missing"),
    captureStatus: status,
    grantSource: grant.grant.source,
    grantSourceId: grant.grant.source_id,
    grantRevision: resolveGrantExtractionManifest(grant).revision,
  };
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
