import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { assertCompanyPathScope, readCompanyWritingPdfSource } from "@/lib/server/documents/companyWritingSources";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ companyId: string; sourceId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { companyId, sourceId } = await context.params;
    const access = await requireCompanyAccess({ companyId });
    assertCompanyPathScope(companyId, access);
    const original = await readCompanyWritingPdfSource({ access, sourceId });
    return new Response(new Uint8Array(original.bytes), { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(original.filename)}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    } });
  } catch (error) { return webActionError(error, { code: "writing_pdf_load_failed", message: "원본 PDF를 불러오지 못했습니다." }); }
}
