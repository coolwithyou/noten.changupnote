import type {
  CompanyInitialMatchResult,
  CompanyProfile,
  MatchingProfileAnswerRequest,
  MatchingProfileView,
  ProfileQuestionEventReceiptDto,
  ProfileQuestionRefreshDto,
  ProfileUpdateImpactDto,
} from "@cunote/contracts";
import {
  OPERATIONAL_PROFILE_DIMENSIONS,
  RULESET_VERSION,
  buildInitialCompanyMatch,
  evaluateProfileUpdateImpact,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
  updateCompanyProfileField,
} from "@cunote/core";
import { annotateMatchCardWriteSupport } from "@/lib/server/matches/annotateWriteSupport";
import { bestEffortMatchCardAnnotation } from "@/lib/server/matches/bestEffortMatchCardAnnotation";
import { refreshProfileQuestionMatchStates } from "@/lib/server/matches/profileQuestionMatchRefresh";
import {
  getServiceRepositories,
  loadServiceGrantUniverse,
  resolveProductCompanyProfile,
} from "@/lib/server/serviceData";
import { buildMatchingProfileView } from "./resolveProductCompanyProfile";

const OPERATIONAL_DIMENSIONS = new Set<string>(OPERATIONAL_PROFILE_DIMENSIONS);

export interface ApplyCompanyProfileAnswerInput {
  companyId: string;
  userId: string;
  answer: MatchingProfileAnswerRequest;
  questionSessionId?: string;
  asOf?: Date;
}

export interface ApplyCompanyProfileAnswerResult {
  profile: CompanyProfile;
  profileView: MatchingProfileView;
  impact: ProfileUpdateImpactDto;
  refresh: ProfileQuestionRefreshDto;
  event: ProfileQuestionEventReceiptDto;
  initialMatch: CompanyInitialMatchResult;
}

export class CompanyProfileAnswerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CompanyProfileAnswerError";
  }
}

export async function applyCompanyProfileAnswer(
  input: ApplyCompanyProfileAnswerInput,
): Promise<ApplyCompanyProfileAnswerResult> {
  const asOf = input.asOf ?? new Date();
  const answer = validateAnswer(input.answer);
  const repositories = getServiceRepositories();
  const [before, current, grants] = await Promise.all([
    resolveProductCompanyProfile({
      context: "owned_read",
      companyId: input.companyId,
      userId: input.userId,
      asOf: asOf.toISOString(),
    }),
    repositories.companies.resolveCompanyProfile({
      companyId: input.companyId,
      userId: input.userId,
    }),
    loadServiceGrantUniverse({ asOf }),
  ]);
  if (!current) {
    throw new CompanyProfileAnswerError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");
  }

  const updatedStoredProfile = applyAnswer(current, answer, asOf);
  const effectiveProfile = applyAnswer(before.profile, answer, asOf);
  await repositories.companies.saveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
    profile: updatedStoredProfile,
  });

  const impact = evaluateProfileUpdateImpact({
    grants,
    beforeProfile: before.profile,
    afterProfile: effectiveProfile,
    dimension: answer.field,
    windowLimit: grants.length,
  });
  const initialMatch = buildInitialCompanyMatch({
    company: effectiveProfile,
    grants,
    asOf,
    limit: 12,
  });
  const sessionId = validUuid(input.questionSessionId) ?? crypto.randomUUID();
  const [refresh, annotatedMatches, event] = await Promise.all([
    refreshProfileQuestionMatchStates({
      repositories,
      companyId: input.companyId,
      userId: input.userId,
      company: effectiveProfile,
      grants,
      impact,
      asOf,
    }),
    bestEffortMatchCardAnnotation(initialMatch.matches, annotateMatchCardWriteSupport),
    recordQuestionEvent({
      repositories,
      companyId: input.companyId,
      userId: input.userId,
      sessionId,
      impact,
    }),
  ]);
  initialMatch.matches = annotatedMatches;

  return {
    profile: effectiveProfile,
    profileView: buildMatchingProfileView(effectiveProfile, asOf.toISOString()),
    impact,
    refresh,
    event,
    initialMatch,
  };
}

function validateAnswer(answer: MatchingProfileAnswerRequest): MatchingProfileAnswerRequest {
  if (!answer || typeof answer !== "object" || typeof answer.field !== "string") {
    throw new CompanyProfileAnswerError("invalid_profile_field", "field가 필요합니다.", 400, "field");
  }
  if (!OPERATIONAL_DIMENSIONS.has(answer.field)) {
    throw new CompanyProfileAnswerError(
      "invalid_profile_field",
      `${answer.field}는 지원하지 않는 프로필 필드입니다.`,
      400,
      "field",
    );
  }
  if (answer.mode !== undefined && answer.mode !== "replace" && answer.mode !== "merge") {
    throw new CompanyProfileAnswerError("invalid_profile_mode", "mode가 올바르지 않습니다.", 400, "mode");
  }
  const hasValue = Object.hasOwn(answer, "value");
  const hasUnknown = answer.unknown === true;
  const hasRange = answer.range !== undefined;
  if (Number(hasValue) + Number(hasUnknown) + Number(hasRange) !== 1) {
    throw new CompanyProfileAnswerError(
      "ambiguous_profile_answer",
      "value, unknown, range 중 하나만 보내야 합니다.",
      400,
      "answer",
    );
  }
  if (hasRange && !validRange(answer.field, answer.range)) {
    throw new CompanyProfileAnswerError(
      "invalid_profile_range",
      "매출·근로자 구간이 올바르지 않습니다.",
      400,
      "range",
    );
  }
  return answer;
}

function applyAnswer(
  profile: CompanyProfile,
  answer: MatchingProfileAnswerRequest,
  asOf: Date,
): CompanyProfile {
  if (answer.unknown === true) {
    return markProfileQuestionUnknown({
      profile,
      dimension: answer.field,
      answeredAt: asOf,
      rulesetVer: RULESET_VERSION,
    });
  }
  if (answer.range && (answer.field === "revenue" || answer.field === "employees")) {
    return markProfileQuestionRange({
      profile,
      dimension: answer.field,
      range: answer.range,
      answeredAt: asOf,
      rulesetVer: RULESET_VERSION,
    });
  }
  return updateCompanyProfileField(profile, {
    field: answer.field,
    value: answer.value,
    confidence: 0.6,
    mode: answer.mode ?? "replace",
    sourceKind: "self_declared",
    provider: "cunote_profile_question",
    asOf: asOf.toISOString(),
  });
}

function validRange(
  field: MatchingProfileAnswerRequest["field"],
  range: MatchingProfileAnswerRequest["range"],
): boolean {
  if (!range || (field !== "revenue" && field !== "employees")) return false;
  if (typeof range.min !== "number" || !Number.isFinite(range.min) || range.min < 0) return false;
  if (range.max !== null && (typeof range.max !== "number" || !Number.isFinite(range.max) || range.max < range.min)) {
    return false;
  }
  return range.unit === (field === "revenue" ? "krw" : "people");
}

function validUuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

async function recordQuestionEvent(input: {
  repositories: ReturnType<typeof getServiceRepositories>;
  companyId: string;
  userId: string;
  sessionId: string;
  impact: ProfileUpdateImpactDto;
}): Promise<ProfileQuestionEventReceiptDto> {
  try {
    return await input.repositories.matches.saveProfileQuestionEvent({
      companyId: input.companyId,
      userId: input.userId,
      sessionId: input.sessionId,
      impact: input.impact,
      rulesetVer: RULESET_VERSION,
    });
  } catch (error) {
    console.warn("profile_question_event_not_persisted", error);
    return {
      id: `unpersisted:${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      recordedAt: new Date().toISOString(),
      persisted: false,
    };
  }
}
