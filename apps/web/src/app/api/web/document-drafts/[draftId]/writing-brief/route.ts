import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadWritingContext, saveWritingBrief } from "@/lib/server/documents/writingContext";
import { readWritingBody } from "@/lib/server/documents/writingRequest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ draftId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const [access, { draftId }] = await Promise.all([requireCompanyAccess(), context.params]);
    return NextResponse.json({ ok: true, data: await loadWritingContext({ access, draftId }) });
  } catch (error) { return webActionError(error, { code: "writing_load_failed", message: "작성 자료를 불러오지 못했습니다." }); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const [access, { draftId }, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params, readWritingBody(request)]);
    return NextResponse.json({ ok: true, data: await saveWritingBrief({ access, draftId, body }) });
  } catch (error) { return webActionError(error, { code: "writing_save_failed", message: "사업 설명을 저장하지 못했습니다." }); }
}
