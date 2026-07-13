import type { CriterionDimension, ProfileQuestionRefreshDto } from "@cunote/contracts";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  buildInitialCompanyMatch,
  evaluateProfileUpdateImpact,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
  RULESET_VERSION,
  updateCompanyProfileField,
  type ProfileQuestionEventReceipt,
  type ProfileUpdateImpact,
} from "@cunote/core";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { annotateMatchCardWriteSupport } from "@/lib/server/matches/annotateWriteSupport";
import { bestEffortMatchCardAnnotation } from "@/lib/server/matches/bestEffortMatchCardAnnotation";
import { refreshProfileQuestionMatchStates } from "@/lib/server/matches/profileQuestionMatchRefresh";
import { getServiceRepositories, loadServiceGrantUniverse } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

interface ProfileFieldRequest {
  field?: CriterionDimension;
  value?: unknown;
  confidence?: number | null;
  mode?: "replace" | "merge";
  questionSessionId?: string;
  unknown?: boolean;
  range?: { min?: unknown; max?: unknown; unit?: unknown };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!body.field) {
      return appError("invalid_profile_field", "field가 필요합니다.", 400, "field");
    }
    if (!isCriterionDimension(body.field)) {
      return appError("invalid_profile_field", `${body.field}는 지원하지 않는 프로필 필드입니다.`, 400, "field");
    }

    const repositories = getServiceRepositories();
    const current = await repositories.companies.resolveCompanyProfile({
      companyId,
      userId: access.userId,
    });
    if (!current) return appError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");

    const asOf = new Date();
    const range = body.range === undefined ? null : parseQuestionRange(body.field, body.range);
    if (body.range !== undefined && !range) {
      return appError("invalid_profile_range", "매출·근로자 구간이 올바르지 않습니다.", 400, "range");
    }
    const profile = range
      ? markProfileQuestionRange({
        profile: current,
        dimension: body.field as "revenue" | "employees",
        range,
        answeredAt: asOf,
        rulesetVer: RULESET_VERSION,
      })
      : body.unknown === true
      ? markProfileQuestionUnknown({
        profile: current,
        dimension: body.field,
        answeredAt: asOf,
        rulesetVer: RULESET_VERSION,
      })
      : updateCompanyProfileField(current, {
        field: body.field,
        value: body.value,
        confidence: body.confidence ?? null,
        mode: body.mode ?? "replace",
        sourceKind: "self_declared",
        provider: "cunote_profile_question",
        asOf: asOf.toISOString(),
      });
    const grants = await loadServiceGrantUniverse({ asOf });
    const saved = await repositories.companies.saveCompanyProfile({
      companyId,
      userId: access.userId,
      profile,
    });
    const impact = evaluateProfileUpdateImpact({
      grants,
      beforeProfile: current,
      afterProfile: saved,
      dimension: body.field,
      windowLimit: grants.length,
    });
    const initialMatch = buildInitialCompanyMatch({
      company: saved,
      grants,
      asOf,
      limit: 12,
    });
    const sessionId = validUuid(body.questionSessionId) ?? crypto.randomUUID();
    const [refresh, annotatedMatches, event]: [ProfileQuestionRefreshDto, typeof initialMatch.matches, ProfileQuestionEventReceipt] = await Promise.all([
      refreshProfileQuestionMatchStates({
        repositories,
        companyId,
        userId: access.userId,
        company: saved,
        grants,
        impact,
        asOf,
      }),
      bestEffortMatchCardAnnotation(initialMatch.matches, annotateMatchCardWriteSupport),
      recordQuestionEvent({
        repositories,
        companyId,
        userId: access.userId,
        sessionId,
        impact,
      }),
    ]);
    initialMatch.matches = annotatedMatches;

    return appData({ profile: saved, impact, refresh, event, initialMatch });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 프로필 입력을 저장하지 못했습니다.");
  }
}

function parseQuestionRange(
  dimension: CriterionDimension,
  value: { min?: unknown; max?: unknown; unit?: unknown },
): { min: number; max: number | null; unit: "krw" | "people" } | null {
  if (dimension !== "revenue" && dimension !== "employees") return null;
  if (typeof value.min !== "number" || !Number.isFinite(value.min) || value.min < 0) return null;
  if (value.max !== null && (typeof value.max !== "number" || !Number.isFinite(value.max) || value.max < value.min)) return null;
  const unit = dimension === "revenue" ? "krw" : "people";
  if (value.unit !== unit) return null;
  return { min: Math.floor(value.min), max: value.max === null ? null : Math.floor(value.max), unit };
}

async function readBody(request: Request): Promise<ProfileFieldRequest> {
  try {
    const parsed = await request.json() as ProfileFieldRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isCriterionDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string" && (CRITERION_DIMENSIONS as readonly string[]).includes(value);
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
  impact: ProfileUpdateImpact;
}): Promise<ProfileQuestionEventReceipt> {
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
