import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  binaryDownloadResponse,
  textDownloadResponse,
  markdownDownloadResponse,
  sanitizeDownloadFilename,
} from "@/lib/server/documents/downloadHeaders";
import {
  documentDraftDocxContentType,
  renderDocumentDraftDocx,
} from "@/lib/server/documents/draftDocxExport";
import { renderDocumentDraftHtml, renderDocumentDraftMarkdown } from "@/lib/server/documents/draftHtmlExport";
import {
  documentDraftPdfContentType,
  renderDocumentDraftPdf,
} from "@/lib/server/documents/draftPdfExport";
import { recordGrantDocumentDraftExport } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    draftId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const format = normalizeDraftExportFormat(new URL(request.url).searchParams.get("format"));
    const draft = await recordGrantDocumentDraftExport({ draftId, access, format });
    const filenameBase = sanitizeDownloadFilename(draft.documentName, "지원서-초안");
    const fallbackBase = `cunote-draft-${draft.id.slice(0, 8)}`;

    if (format === "html") {
      return textDownloadResponse({
        body: renderDocumentDraftHtml({ draft }),
        filename: `창업노트-${filenameBase}-${draft.id.slice(0, 8)}.html`,
        fallbackFilename: `${fallbackBase}.html`,
        contentType: "text/html; charset=utf-8",
      });
    }

    if (format === "docx") {
      return binaryDownloadResponse({
        body: renderDocumentDraftDocx({ draft }),
        filename: `창업노트-${filenameBase}-${draft.id.slice(0, 8)}.docx`,
        fallbackFilename: `${fallbackBase}.docx`,
        contentType: documentDraftDocxContentType(),
      });
    }

    if (format === "pdf") {
      return binaryDownloadResponse({
        body: renderDocumentDraftPdf({ draft }),
        filename: `창업노트-${filenameBase}-${draft.id.slice(0, 8)}.pdf`,
        fallbackFilename: `${fallbackBase}.pdf`,
        contentType: documentDraftPdfContentType(),
      });
    }

    return markdownDownloadResponse({
      markdown: renderDocumentDraftMarkdown({ draft }),
      filename: `창업노트-${filenameBase}-${draft.id.slice(0, 8)}.md`,
      fallbackFilename: `${fallbackBase}.md`,
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "draft_download_failed",
      message: "초안 파일을 다운로드하지 못했습니다.",
    });
  }
}

function normalizeDraftExportFormat(value: string | null): "markdown" | "html" | "docx" | "pdf" {
  if (value === "html" || value === "docx" || value === "pdf") return value;
  return "markdown";
}
