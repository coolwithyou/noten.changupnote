import { NextResponse } from "next/server";
import {
  assertDevOnly,
  clearServiceDataCache,
  inspectServiceData,
  loadDevServiceDataShadowMatch,
  lookupServiceData,
  type ServiceDataProvider,
} from "@/lib/server/devServiceDataMonitor";
import {
  buildDevFinalCompanyProfile,
  buildDevQnaProfileUpdates,
  sanitizeDevServiceDataJson,
  type DevQnaAnswerDto,
} from "@/lib/server/devServiceDataProfile";
import { ServiceDataError } from "@/lib/server/serviceData";
import { CRITERION_DIMENSIONS, type CompanyProfile, type CriterionDimension } from "@cunote/contracts";
import type { CompanyProfileFieldUpdate } from "@cunote/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** 하이픈 등 비숫자를 제거한 사업자번호가 정확히 10자리면 반환, 아니면 null. */
function normalizeBizNo(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

const invalidBizNo = () =>
  NextResponse.json({ error: "invalid_biz_no", message: "사업자번호 10자리를 입력해주세요." }, { status: 400 });

function normalizeProvider(raw: unknown): ServiceDataProvider | null {
  if (raw === null || raw === undefined || raw === "" || raw === "popbill") return "popbill";
  if (raw === "apick") return "apick";
  return null;
}

const invalidProvider = () =>
  NextResponse.json({ error: "invalid_provider", message: "provider는 popbill 또는 apick만 가능합니다." }, { status: 400 });

export async function GET(request: Request) {
  if (isProduction()) return notFound();
  assertDevOnly();

  const bizNo = normalizeBizNo(new URL(request.url).searchParams.get("bizNo"));
  if (!bizNo) return invalidBizNo();

  const provider = normalizeProvider(new URL(request.url).searchParams.get("provider"));
  if (!provider) return invalidProvider();
  const result = await inspectServiceData(bizNo, provider);
  return NextResponse.json(sanitizeDevServiceDataJson(result));
}

export async function POST(request: Request) {
  if (isProduction()) return notFound();
  assertDevOnly();

  const body = (await request.json().catch(() => null)) as
    | {
        action?: unknown;
        answers?: unknown;
        asOf?: unknown;
        baseProfile?: unknown;
        bizNo?: unknown;
        connectorNormalizedDimensions?: unknown;
        connectorProfileUpdates?: unknown;
        connectorSourcedDimensions?: unknown;
        detailLimit?: unknown;
        finalProfile?: unknown;
        forceRefresh?: unknown;
        provider?: unknown;
        qnaAsOf?: unknown;
        scanLimit?: unknown;
      }
    | null;
  if (body?.action === "shadow_match") {
    if (
      !isShadowCompanyProfile(body.baseProfile) ||
      !isShadowCompanyProfile(body.finalProfile) ||
      typeof body.asOf !== "string" ||
      Number.isNaN(Date.parse(body.asOf)) ||
      !isOptionalBoundedInteger(body.detailLimit, 1, 200) ||
      !isOptionalBoundedInteger(body.scanLimit, 1, 20_000)
    ) {
      return NextResponse.json(
        { error: "invalid_shadow_match", message: "shadow match 프로필·asOf·limit 입력 형식이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    try {
      const result = await loadDevServiceDataShadowMatch({
        baseProfile: body.baseProfile,
        finalProfile: body.finalProfile,
        asOf: new Date(body.asOf),
        ...(body.detailLimit !== undefined ? { detailLimit: body.detailLimit } : {}),
        ...(body.scanLimit !== undefined ? { scanLimit: body.scanLimit } : {}),
      });
      return NextResponse.json(sanitizeDevServiceDataJson(result));
    } catch (error) {
      if (error instanceof ServiceDataError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      }
      return NextResponse.json(
        { error: "shadow_match_failed", message: "shadow match 입력을 평가하지 못했습니다." },
        { status: 400 },
      );
    }
  }
  if (body?.action === "normalize_qna") {
    const answers = body.answers as DevQnaAnswerDto | null;
    if (
      !answers ||
      (answers.scenario !== "registered_business" && answers.scenario !== "preliminary") ||
      !Array.isArray(answers.answers) ||
      !answers.answers.every((answer) =>
        answer !== null && typeof answer === "object" && typeof answer.definitionId === "string")
    ) {
      return NextResponse.json(
        { error: "invalid_qna_answers", message: "Q&A 답변 형식이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    // G2B는 직렬화 답의 typed 검증까지만 맡는다. G3에서 실제 병합할 때는 connector-merged
    // CompanyProfile을 baseProfile로 전달해 다시 변환해야 authoritative/compound 값을 보존한다.
    return NextResponse.json(sanitizeDevServiceDataJson(buildDevQnaProfileUpdates(answers)));
  }
  if (body?.action === "merge_profile") {
    const answers = body.answers as DevQnaAnswerDto | null;
    if (
      !isRecord(body.baseProfile) ||
      !Array.isArray(body.connectorProfileUpdates) ||
      !body.connectorProfileUpdates.every(isProfileUpdate) ||
      !isDimensionArray(body.connectorSourcedDimensions) ||
      !isDimensionArray(body.connectorNormalizedDimensions) ||
      (answers !== null && answers !== undefined && !isQnaAnswers(answers)) ||
      (answers && (typeof body.qnaAsOf !== "string" || Number.isNaN(Date.parse(body.qnaAsOf))))
    ) {
      return NextResponse.json(
        { error: "invalid_profile_merge", message: "프로필 병합 입력 형식이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    try {
      const result = buildDevFinalCompanyProfile({
        baseProfile: body.baseProfile as CompanyProfile,
        connectorProfileUpdates: body.connectorProfileUpdates,
        connectorSourcedDimensions: body.connectorSourcedDimensions,
        connectorNormalizedDimensions: body.connectorNormalizedDimensions,
        ...(answers ? { qna: { answers, asOf: body.qnaAsOf as string } } : {}),
      });
      return NextResponse.json(sanitizeDevServiceDataJson(result));
    } catch {
      return NextResponse.json(
        { error: "profile_merge_failed", message: "프로필 병합 입력을 정규화하지 못했습니다." },
        { status: 400 },
      );
    }
  }
  const bizNo = normalizeBizNo(typeof body?.bizNo === "string" ? body.bizNo : null);
  if (!bizNo) return invalidBizNo();

  const forceRefresh = body?.forceRefresh === true;
  const provider = normalizeProvider(body?.provider);
  if (!provider) return invalidProvider();
  // ServiceDataError(폐업·미등록 등)는 모듈이 200 + error 필드(트레이스 포함)로 담아 반환한다.
  const result = await lookupServiceData(bizNo, { forceRefresh, provider });
  return NextResponse.json(sanitizeDevServiceDataJson(result));
}

export async function DELETE(request: Request) {
  if (isProduction()) return notFound();
  assertDevOnly();

  const params = new URL(request.url).searchParams;
  const bizNo = normalizeBizNo(params.get("bizNo"));
  if (!bizNo) return invalidBizNo();

  const provider = normalizeProvider(params.get("provider"));
  if (!provider) return invalidProvider();
  const result = await clearServiceDataCache(bizNo, provider);
  return NextResponse.json(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string" && (CRITERION_DIMENSIONS as readonly string[]).includes(value);
}

function isDimensionArray(value: unknown): value is CriterionDimension[] {
  return value === undefined || (Array.isArray(value) && value.every(isDimension));
}

function isProfileUpdate(value: unknown): value is CompanyProfileFieldUpdate {
  return isRecord(value) && isDimension(value.field) && "value" in value;
}

function isQnaAnswers(value: unknown): value is DevQnaAnswerDto {
  if (!isRecord(value)) return false;
  return (value.scenario === "registered_business" || value.scenario === "preliminary") &&
    Array.isArray(value.answers) &&
    value.answers.every((answer) => isRecord(answer) && typeof answer.definitionId === "string");
}

function isOptionalBoundedInteger(value: unknown, min: number, max: number): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
}

function isShadowCompanyProfile(value: unknown): value is CompanyProfile {
  if (!isRecord(value)) return false;
  for (const key of ["industries", "industry_codes", "traits", "certs", "prior_awards", "ip", "target_types"] as const) {
    if (value[key] !== undefined && !isStringArray(value[key])) return false;
  }
  for (const key of ["biz_age_months", "founder_age", "revenue_krw", "employees_count"] as const) {
    if (value[key] !== undefined && value[key] !== null && !isFiniteNumber(value[key])) return false;
  }
  for (const key of [
    "other_conditions",
    "business_status",
    "tax_compliance",
    "credit_status",
    "sanction",
    "financial_health",
    "insured_workforce",
    "investment",
    "profile_evidence",
    "question_answer_state",
  ] as const) {
    if (value[key] !== undefined && value[key] !== null && !isRecord(value[key])) return false;
  }
  if (value.region !== undefined &&
    (!isRecord(value.region) || typeof value.region.code !== "string")) return false;
  if (value.confidence !== undefined &&
    (!isRecord(value.confidence) || Object.entries(value.confidence).some(([dimension, entry]) =>
      !isDimension(dimension) || !isFiniteNumber(entry)))) return false;
  if (value.list_completeness !== undefined &&
    (!isRecord(value.list_completeness) || Object.values(value.list_completeness).some((entry) =>
      entry !== "partial" && entry !== "complete"))) return false;
  if (value.prior_award_history !== undefined) {
    if (!isRecord(value.prior_award_history) || !Array.isArray(value.prior_award_history.records) ||
      !isStringArray(value.prior_award_history.known_programs) ||
      !isStringArray(value.prior_award_history.known_program_types)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
