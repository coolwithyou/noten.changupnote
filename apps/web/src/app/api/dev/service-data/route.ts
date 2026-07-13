import { NextResponse } from "next/server";
import {
  assertDevOnly,
  clearServiceDataCache,
  inspectServiceData,
  lookupServiceData,
  type ServiceDataProvider,
} from "@/lib/server/devServiceDataMonitor";
import {
  buildDevFinalCompanyProfile,
  buildDevQnaProfileUpdates,
  sanitizeDevServiceDataJson,
  type DevQnaAnswerDto,
} from "@/lib/server/devServiceDataProfile";
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
        baseProfile?: unknown;
        bizNo?: unknown;
        connectorNormalizedDimensions?: unknown;
        connectorProfileUpdates?: unknown;
        connectorSourcedDimensions?: unknown;
        forceRefresh?: unknown;
        provider?: unknown;
        qnaAsOf?: unknown;
      }
    | null;
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
