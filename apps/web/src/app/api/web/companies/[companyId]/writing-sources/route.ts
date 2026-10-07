import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { assertCompanyPathScope, createCompanyWritingSource, listCompanyWritingSources } from "@/lib/server/documents/companyWritingSources";
import { readWritingBody } from "@/lib/server/documents/writingRequest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ companyId: string }> };
/** 회사 공통 자료 목록(이번 신청 전용 포함). 경로의 회사에 대한 membership을 세션으로 검증한다. */
export async function GET(_request: Request, context: Context) {
  try {
    const { companyId } = await context.params;
    const access = await requireCompanyAccess({ companyId });
    assertCompanyPathScope(companyId, access);
    return NextResponse.json({ ok: true, data: await listCompanyWritingSources({ access }) }, { headers });
  } catch (error) { return webActionError(error, { code: "writing_sources_load_failed", message: "회사 자료를 불러오지 못했습니다." }); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { companyId } = await context.params;
    const [access, body] = await Promise.all([requireCompanyAccess({ companyId, permission: "write" }), readWritingBody(request)]);
    assertCompanyPathScope(companyId, access);
    return NextResponse.json({ ok: true, data: await createCompanyWritingSource({ access, body }) }, { headers });
  } catch (error) { return webActionError(error, { code: "writing_source_save_failed", message: "회사 자료를 저장하지 못했습니다." }); }
}
