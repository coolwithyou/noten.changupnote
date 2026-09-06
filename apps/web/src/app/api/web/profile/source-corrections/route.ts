import { NextResponse } from "next/server";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import { requireWebSession } from "@/lib/server/auth/session";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { requestCompanyScope } from "@/lib/server/auth/requestCompanyScope";
import { webActionError } from "@/lib/server/auth/webActionError";
import { resolveProductCompanyProfileWithoutCorrections } from "@/lib/server/serviceData";
import { correctionError, createSourceCorrection, listSourceCorrections, sourceCorrectionsEnabled, updateOwnSourceCorrection } from "@/lib/server/productProfile/sourceCorrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireWebSession();
    if (!sourceCorrectionsEnabled()) return NextResponse.json({ ok: true, data: { enabled: false, records: [] } });
    const access = await requireCompanyAccess(requestCompanyScope(new URL(request.url).searchParams.get("companyId")));
    return NextResponse.json({ ok: true, data: { enabled: true, records: await listSourceCorrections(access) } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    if (!sourceCorrectionsEnabled()) throw correctionError("source_corrections_disabled", "원천 정정 기능을 준비 중입니다.", 503);
    const text = await request.text();
    if (text.length > 8000) throw correctionError("body_too_large", "요청이 너무 큽니다.", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw correctionError("invalid_body", "요청 내용을 확인해주세요."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw correctionError("invalid_body", "요청 내용을 확인해주세요.");
    const access = await requireCompanyAccess({ ...requestCompanyScope(body.companyId ?? null), permission: "write" });
    const resolution = body.action === "withdraw" ? { profile: {} } : await resolveProductCompanyProfileWithoutCorrections({ context: "owned_read", companyId: access.companyId, userId: access.userId, asOf: new Date().toISOString() });
    if (body.action === "submit" && typeof body.dimension === "string" && CRITERION_DIMENSIONS.includes(body.dimension as never)) {
      const record = await createSourceCorrection({ access, email: session.user.email ?? "", dimension: body.dimension as typeof CRITERION_DIMENSIONS[number], statement: body.statement, profile: resolution.profile });
      return NextResponse.json({ ok: true, data: record }, { status: 201 });
    }
    if ((body.action === "recheck" || body.action === "withdraw") && typeof body.id === "string" && /^[a-f0-9-]{36}$/i.test(body.id) && Number.isInteger(body.revision)) {
      const record = await updateOwnSourceCorrection({ access, id: body.id, revision: body.revision as number, action: body.action, profile: resolution.profile });
      return NextResponse.json({ ok: true, data: record });
    }
    throw correctionError("invalid_action", "정정 요청과 필드를 확인해주세요.");
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  return webActionError(error, { code: "source_correction_failed", message: "원천 정정 요청을 처리하지 못했습니다." });
}
