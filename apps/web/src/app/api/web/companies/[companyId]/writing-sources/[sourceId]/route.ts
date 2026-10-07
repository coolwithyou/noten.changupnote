import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { assertCompanyPathScope, readCompanyWritingSource, withdrawCompanyWritingSource } from "@/lib/server/documents/companyWritingSources";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ companyId: string; sourceId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { companyId, sourceId } = await context.params;
    const access = await requireCompanyAccess({ companyId });
    assertCompanyPathScope(companyId, access);
    return NextResponse.json({ ok: true, data: await readCompanyWritingSource({ access, sourceId }) }, { headers });
  } catch (error) { return webActionError(error, { code: "writing_source_load_failed", message: "자료를 불러오지 못했습니다." }); }
}
/** 물리 삭제가 아니라 사용 중단(withdraw)이다. 이미 저장한 문서 내용은 유지된다. */
export async function DELETE(_request: Request, context: Context) {
  try {
    const { companyId, sourceId } = await context.params;
    const access = await requireCompanyAccess({ companyId, permission: "write" });
    assertCompanyPathScope(companyId, access);
    return NextResponse.json({ ok: true, data: await withdrawCompanyWritingSource({ access, sourceId }) }, { headers });
  } catch (error) { return webActionError(error, { code: "writing_source_withdraw_failed", message: "자료 사용을 중단하지 못했습니다." }); }
}
