import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { readWritingSource, withdrawWritingSource } from "@/lib/server/documents/writingContext";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ draftId: string; sourceId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const [access, params] = await Promise.all([requireCompanyAccess(), context.params]);
    return NextResponse.json({ ok: true, data: await readWritingSource({ access, ...params }) });
  } catch (error) { return webActionError(error, { code: "writing_source_load_failed", message: "자료를 불러오지 못했습니다." }); }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    const [access, params] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params]);
    return NextResponse.json({ ok: true, data: await withdrawWritingSource({ access, ...params }) });
  } catch (error) { return webActionError(error, { code: "writing_source_withdraw_failed", message: "자료 사용을 중단하지 못했습니다." }); }
}
