import { NextResponse } from "next/server";
import {
  assertDevOnly,
  clearServiceDataCache,
  inspectServiceData,
  lookupServiceData,
  type ServiceDataProvider,
} from "@/lib/server/devServiceDataMonitor";

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
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  if (isProduction()) return notFound();
  assertDevOnly();

  const body = (await request.json().catch(() => null)) as
    | { bizNo?: unknown; forceRefresh?: unknown; provider?: unknown }
    | null;
  const bizNo = normalizeBizNo(typeof body?.bizNo === "string" ? body.bizNo : null);
  if (!bizNo) return invalidBizNo();

  const forceRefresh = body?.forceRefresh === true;
  const provider = normalizeProvider(body?.provider);
  if (!provider) return invalidProvider();
  // ServiceDataError(폐업·미등록 등)는 모듈이 200 + error 필드(트레이스 포함)로 담아 반환한다.
  const result = await lookupServiceData(bizNo, { forceRefresh, provider });
  return NextResponse.json(result);
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
