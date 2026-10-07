import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadWritingSections, requestWritingSection, saveWritingSection } from "@/lib/server/documents/writingSections";
import { readWritingBody } from "@/lib/server/documents/writingRequest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ draftId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const [access, { draftId }] = await Promise.all([requireCompanyAccess(), context.params]);
    return NextResponse.json({ ok: true, data: await loadWritingSections({ access, draftId }) });
  } catch (error) { return webActionError(error, { code: "writing_sections_load_failed", message: "문안을 불러오지 못했습니다." }); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const [access, { draftId }, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params, readWritingBody(request)]);
    return NextResponse.json({ ok: true, data: await saveWritingSection({ access, draftId, body }) });
  } catch (error) { return webActionError(error, { code: "writing_section_save_failed", message: "문안을 저장하지 못했습니다." }); }
}
export async function POST(request: Request, context: Context) {
  try {
    const [access, { draftId }, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params, readWritingBody(request)]);
    const data = await requestWritingSection({ access, draftId, body });
    return NextResponse.json({ ok: true, data }, { status: data.sections.some(section => section.proposal?.status === "running") ? 202 : 200 });
  } catch (error) { return webActionError(error, { code: "writing_section_generate_failed", message: "문항 초안을 완성하지 못했습니다." }); }
}
