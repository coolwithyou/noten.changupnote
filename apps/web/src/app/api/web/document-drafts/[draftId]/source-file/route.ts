import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { loadDraftSourceFile } from "@/lib/server/documents/draftSourceFile";
import { getGrantDocumentDraft } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const draft = await getGrantDocumentDraft({ draftId, access });
    const source = await loadDraftSourceFile({ draft });
    const filename = sanitizeDownloadFilename(source.filename, `cunote-source-${draft.id.slice(0, 8)}`);
    const body = new ArrayBuffer(source.body.byteLength);
    new Uint8Array(body).set(source.body);
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": source.contentType,
        "x-content-type-options": "nosniff",
        "x-cunote-document-format": source.format,
        "x-cunote-document-filename": encodeURIComponent(filename),
      },
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "document_source_load_failed",
      message: "원본 HWP/HWPX 양식을 불러오지 못했습니다.",
    });
  }
}
