import type { CompanyProfile, CriterionDimension } from "@cunote/contracts";

export const DEFAULT_UNKNOWN_ANSWER_TTL_DAYS = 30;
export const DEFAULT_RANGE_ANSWER_TTL_DAYS = 180;

export interface NumericQuestionRange {
  min: number;
  max: number | null;
  unit: "krw" | "people";
}

export function markProfileQuestionUnknown(input: {
  profile: CompanyProfile;
  dimension: CriterionDimension;
  answeredAt?: Date;
  ttlDays?: number;
  rulesetVer?: string | null;
}): CompanyProfile {
  const answeredAt = input.answeredAt ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_UNKNOWN_ANSWER_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 365) {
    throw new Error("unknown answer ttlDays must be > 0 and <= 365");
  }
  const expiresAt = new Date(answeredAt.getTime() + ttlDays * 86_400_000);
  // A later "I don't know" withdraws an earlier user answer. Keeping its value
  // would continue to qualify the company even though the answer is now unknown.
  // Provider facts remain available when the user does not know the answer.
  const evidence = input.profile.profile_evidence?.[input.dimension];
  const profile = !evidence || evidence.sourceKind === "self_declared"
    ? withoutQuestionAnswerValue(input.profile, input.dimension)
    : input.profile;
  return {
    ...profile,
    question_answer_state: {
      ...(profile.question_answer_state ?? {}),
      [input.dimension]: {
        status: "unknown",
        answeredAt: answeredAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        sourceKind: "self_declared",
        rulesetVer: input.rulesetVer ?? null,
      },
    },
  };
}

function withoutQuestionAnswerValue(profile: CompanyProfile, dimension: CriterionDimension): CompanyProfile {
  const next: CompanyProfile = { ...profile };
  const keys: Partial<Record<CriterionDimension, (keyof CompanyProfile)[]>> = {
    region: ["region"], biz_age: ["biz_age_months"], industry: ["industries", "industry_codes"],
    size: ["size"], revenue: ["revenue_krw"], employees: ["employees_count"],
    founder_age: ["founder_age"], founder_trait: ["traits"], certification: ["certs"],
    prior_award: ["prior_awards", "prior_award_history"], ip: ["ip"], target_type: ["target_types"],
    business_status: ["business_status"], tax_compliance: ["tax_compliance"],
    credit_status: ["credit_status"], sanction: ["sanction"],
    financial_health: ["financial_health"], insured_workforce: ["insured_workforce"],
    investment: ["investment"], premises: ["premises"], other: ["other_conditions"],
  };
  for (const key of keys[dimension] ?? []) delete next[key];
  if (profile.profile_evidence?.[dimension]) {
    next.profile_evidence = { ...profile.profile_evidence };
    delete next.profile_evidence[dimension];
  }
  if (profile.confidence?.[dimension] !== undefined) {
    next.confidence = { ...profile.confidence };
    delete next.confidence[dimension];
  }
  if (profile.list_completeness) {
    next.list_completeness = { ...profile.list_completeness };
    delete next.list_completeness[dimension as keyof typeof next.list_completeness];
  }
  return next;
}

export function markProfileQuestionRange(input: {
  profile: CompanyProfile;
  dimension: "revenue" | "employees";
  range: NumericQuestionRange;
  answeredAt?: Date;
  ttlDays?: number;
  rulesetVer?: string | null;
}): CompanyProfile {
  const answeredAt = input.answeredAt ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_RANGE_ANSWER_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 365) {
    throw new Error("range answer ttlDays must be > 0 and <= 365");
  }
  const min = normalizeRangeBound(input.range.min, "range.min");
  const max = input.range.max === null ? null : normalizeRangeBound(input.range.max, "range.max");
  if (max !== null && max < min) throw new Error("range.max must be >= range.min");
  const expectedUnit = input.dimension === "revenue" ? "krw" : "people";
  if (input.range.unit !== expectedUnit) throw new Error(`${input.dimension} range unit must be ${expectedUnit}`);
  const existingEvidence = input.profile.profile_evidence?.[input.dimension];
  if (
    existingEvidence?.axisCompleteness === "complete" &&
    (existingEvidence.sourceKind === "authoritative_api" || existingEvidence.sourceKind === "public_registry")
  ) {
    throw new Error(`${input.dimension} is already confirmed by authoritative evidence`);
  }
  const expiresAt = new Date(answeredAt.getTime() + ttlDays * 86_400_000);
  // A range replaces the user's earlier exact number; otherwise the matcher
  // could still decide from that stale exact number instead of the range.
  const profile = withoutQuestionAnswerValue(input.profile, input.dimension);
  return {
    ...profile,
    profile_evidence: {
      ...(profile.profile_evidence ?? {}),
      [input.dimension]: {
        sourceKind: "self_declared",
        provider: "cunote_profile_question_range",
        asOf: answeredAt.toISOString(),
        axisCompleteness: "partial",
        confidence: 0.6,
      },
    },
    question_answer_state: {
      ...(profile.question_answer_state ?? {}),
      [input.dimension]: {
        status: "range",
        answeredAt: answeredAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        sourceKind: "self_declared",
        rulesetVer: input.rulesetVer ?? null,
        min,
        max,
        unit: expectedUnit,
      },
    },
  };
}

export function clearProfileQuestionAnswerState(
  profile: CompanyProfile,
  dimension: CriterionDimension,
): CompanyProfile {
  if (!profile.question_answer_state?.[dimension]) return profile;
  const states = { ...profile.question_answer_state };
  delete states[dimension];
  const next: CompanyProfile = { ...profile };
  if (Object.keys(states).length > 0) next.question_answer_state = states;
  else delete next.question_answer_state;
  return next;
}

export function activeUnknownQuestionDimensions(
  profile: CompanyProfile,
  asOf = new Date(),
): CriterionDimension[] {
  return Object.entries(profile.question_answer_state ?? {}).flatMap(([rawDimension, state]) => {
    if (!state || state.status !== "unknown") return [];
    const expiresAt = Date.parse(state.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= asOf.getTime()) return [];
    return [rawDimension as CriterionDimension];
  });
}

export function activeNumericQuestionRange(
  profile: CompanyProfile,
  dimension: "revenue" | "employees",
  asOf = new Date(),
): NumericQuestionRange | null {
  const state = profile.question_answer_state?.[dimension];
  if (!state || state.status !== "range") return null;
  if (Date.parse(state.expiresAt) <= asOf.getTime()) return null;
  const expectedUnit = dimension === "revenue" ? "krw" : "people";
  if (state.unit !== expectedUnit || typeof state.min !== "number" || !Number.isFinite(state.min) || state.min < 0) return null;
  const max = state.max === null ? null : state.max;
  if (max !== null && (typeof max !== "number" || !Number.isFinite(max) || max < state.min)) return null;
  return { min: state.min, max, unit: expectedUnit };
}

function normalizeRangeBound(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`);
  return Math.floor(value);
}
