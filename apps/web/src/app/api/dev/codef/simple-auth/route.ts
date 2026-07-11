import { NextResponse } from "next/server";
import { CODEF_SIMPLE_AUTH_APPS, type CodefSimpleAuthApp } from "@cunote/core";
import { startSimpleAuth } from "@/lib/server/codef/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// dev 전용 가드 — api/dev/service-data 와 동일 규약(프로덕션 404).
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function normalizeBizNo(raw: unknown): string | null {
  const digits = (typeof raw === "string" ? raw : "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

function normalizeDigits(raw: unknown, min: number, max: number): string | null {
  const digits = (typeof raw === "string" ? raw : "").replace(/\D/g, "");
  return digits.length >= min && digits.length <= max ? digits : null;
}

function isSimpleAuthApp(raw: unknown): raw is CodefSimpleAuthApp {
  return typeof raw === "string" && raw in CODEF_SIMPLE_AUTH_APPS;
}

/** 간편인증 시작. body: { bizNo, name, birth8, phone, authApp, telecom?, gender?, userId? }. */
export async function POST(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const bizNo = normalizeBizNo(body?.bizNo);
  if (!bizNo) {
    return NextResponse.json({ error: "invalid_biz_no", message: "사업자번호 10자리를 입력해주세요." }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "invalid_name", message: "이름을 입력해주세요." }, { status: 400 });
  }
  const birth8 = normalizeDigits(body?.birth8, 8, 8);
  if (!birth8) {
    return NextResponse.json({ error: "invalid_birth", message: "생년월일 8자리(yyyyMMdd)를 입력해주세요." }, { status: 400 });
  }
  const phone = normalizeDigits(body?.phone, 10, 11);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone", message: "휴대폰번호를 입력해주세요." }, { status: 400 });
  }
  if (!isSimpleAuthApp(body?.authApp)) {
    return NextResponse.json(
      { error: "invalid_auth_app", message: "지원하는 인증앱 코드를 선택해주세요." },
      { status: 400 },
    );
  }
  const authApp = body.authApp;
  const telecom = typeof body?.telecom === "string" && body.telecom.trim() ? body.telecom.trim() : undefined;
  const gender = body?.gender === "M" || body?.gender === "F" ? body.gender : null;

  const result = await startSimpleAuth(bizNo, {
    name,
    birth8,
    phone,
    authApp,
    ...(telecom ? { telecom } : {}),
    gender,
  });
  return NextResponse.json(result);
}
