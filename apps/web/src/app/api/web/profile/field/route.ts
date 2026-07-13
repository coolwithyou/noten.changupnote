import type {
  ActionResult,
  CompanyInitialMatchResult,
  CompanyProfile,
  CriterionDimension,
  ProfileQuestionEventReceiptDto,
  ProfileQuestionRefreshDto,
} from "@cunote/contracts";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  buildInitialCompanyMatch,
  evaluateProfileUpdateImpact,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
  RULESET_VERSION,
  updateCompanyProfileField,
  type ProfileUpdateImpact,
} from "@cunote/core";
import { NextRequest, NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { annotateMatchCardWriteSupport } from "@/lib/server/matches/annotateWriteSupport";
import { bestEffortMatchCardAnnotation } from "@/lib/server/matches/bestEffortMatchCardAnnotation";
import { refreshProfileQuestionMatchStates } from "@/lib/server/matches/profileQuestionMatchRefresh";
import { getServiceRepositories, loadServiceGrantUniverse } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProfileFieldRequest {
  field?: CriterionDimension;
  value?: unknown;
  confidence?: number | null;
  mode?: "replace" | "merge";
  questionSessionId?: string;
  unknown?: boolean;
  range?: { min?: unknown; max?: unknown; unit?: unknown };
}

interface ProfileFieldResult {
  profile: CompanyProfile;
  impact: ProfileUpdateImpact;
  refresh: ProfileQuestionRefreshDto;
  event: ProfileQuestionEventReceiptDto;
  initialMatch: CompanyInitialMatchResult;
}

export async function POST(request: NextRequest) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), readBody(request)]);
    if (!body.field) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: {
          code: "invalid_profile_field",
          message: "field가 필요합니다.",
          field: "field",
        },
      }, { status: 400 });
    }
    if (!isCriterionDimension(body.field)) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: {
          code: "invalid_profile_field",
          message: `${body.field}는 지원하지 않는 프로필 필드입니다.`,
          field: "field",
        },
      }, { status: 400 });
    }

    const repositories = getServiceRepositories();
    const current = await repositories.companies.resolveCompanyProfile({
      companyId: access.companyId,
      userId: access.userId,
    });
    if (!current) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: {
          code: "company_not_found",
          message: "회사를 찾지 못했습니다.",
          field: "companyId",
        },
      }, { status: 404 });
    }

    const asOf = new Date();
    const range = body.range === undefined ? null : parseQuestionRange(body.field, body.range);
    if (body.range !== undefined && !range) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: { code: "invalid_profile_range", message: "매출·근로자 구간이 올바르지 않습니다.", field: "range" },
      }, { status: 400 });
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
      companyId: access.companyId,
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
    const sessionId = validUuid(body.questionSessionId) ??
      validUuid(request.cookies.get("cunote_question_session")?.value) ??
      crypto.randomUUID();
    const [refresh, annotatedMatches, event] = await Promise.all([
      refreshProfileQuestionMatchStates({
        repositories,
        companyId: access.companyId,
        userId: access.userId,
        company: saved,
        grants,
        impact,
        asOf,
      }),
      bestEffortMatchCardAnnotation(initialMatch.matches, annotateMatchCardWriteSupport),
      recordQuestionEvent({
        repositories,
        companyId: access.companyId,
        userId: access.userId,
        sessionId,
        impact,
      }),
    ]);
    initialMatch.matches = annotatedMatches;

    const response = NextResponse.json<ActionResult<ProfileFieldResult>>({
      ok: true,
      data: { profile: saved, impact, refresh, event, initialMatch },
    });
    response.cookies.set("cunote_question_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 60,
    });
    return response;
  } catch (error) {
    return webActionError<ProfileFieldResult>(error, {
      code: "profile_field_failed",
      message: "회사 프로필 입력을 저장하지 못했습니다.",
    });
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
