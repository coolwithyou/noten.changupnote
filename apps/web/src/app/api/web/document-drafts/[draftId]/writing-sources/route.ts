import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { createWritingSource } from "@/lib/server/documents/writingContext";
import { readWritingBody } from "@/lib/server/documents/writingRequest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ draftId: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const [access, { draftId }, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params, readWritingBody(request)]);
    return NextResponse.json({ ok: true, data: await createWritingSource({ access, draftId, body }) });
  } catch (error) { return webActionError(error, { code: "writing_source_save_failed", message: "회사 자료를 저장하지 못했습니다." }); }
}
