import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { WritingContextError } from "@/lib/server/documents/writingContext";
import { WRITING_PDF_MAX_BYTES } from "@/lib/server/documents/writingPdfBytes";
import { createWritingPdfSource } from "@/lib/server/documents/writingPdfSources";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ draftId: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const [access, { draftId }] = await Promise.all([requireCompanyAccess({ permission: "write" }), context.params]);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;")) throw new WritingContextError("writing_pdf_invalid", "PDF 파일을 올려 주세요.");
    const reader = request.body?.getReader();
    if (!reader) throw new WritingContextError("writing_pdf_invalid", "PDF 파일이 필요합니다.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > WRITING_PDF_MAX_BYTES + 8192) { await reader.cancel(); throw new WritingContextError("writing_pdf_too_large", "PDF는 4MB 이내로 올려 주세요.", 413); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
    const file = form.get("file"), raw = form.get("metadata");
    if (!(file instanceof File) || typeof raw !== "string" || raw.length > 3000) throw new WritingContextError("writing_pdf_invalid", "PDF 파일과 자료 설명을 확인해 주세요.");
    const metadata = { ...JSON.parse(raw), filename: file.name };
    return NextResponse.json({ ok: true, data: await createWritingPdfSource({ access, draftId, metadata, bytes: Buffer.from(await file.arrayBuffer()) }) });
  } catch (error) { return webActionError(error, { code: "writing_pdf_save_failed", message: "PDF 자료를 보관하지 못했습니다." }); }
}
