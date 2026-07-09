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
import { buildDraftHwpxDownload, DraftHwpxExportError } from "@/lib/server/documents/draftHwpxExport";
import {
  getGrantDocumentDraft,
  recordGrantDocumentDraftExport,
} from "@/lib/server/documents/grantDocumentDrafts";

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

/**
 * HWPX 원본 양식 채움 다운로드 (설계 결정 6·8, Phase 2 · Apply Experience v2 ADR-5).
 * 채움 값은 **서버 저장 파생 filledFields(accepted|edited 만)** 를 그대로 사용한다.
 * 클라이언트 body `answers` 동봉은 폐기됐다(컨펌 게이트의 서버 집행) — body 는 `{format:"hwpx"}` 만 요구.
 * 미채움 라벨(정규화 label 충돌 제외분 포함)은 X-Cunote-Hwpx-Unfilled 헤더로 전달한다.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    await parseHwpxDownloadBody(request);

    // 읽기로 초안을 먼저 확보한 뒤 채움을 시도하고, 성공했을 때만 export 이력을 남긴다
    // (위장 파일 등으로 실패한 다운로드를 내보냄으로 기록하지 않기 위함).
    const draft = await getGrantDocumentDraft({ draftId, access });
    const result = await buildDraftHwpxDownload({ draft });
    await recordGrantDocumentDraftExport({ draftId, access, format: "hwpx" });

    const filenameBase = sanitizeDownloadFilename(draft.documentName, "지원서-초안");
    const fallbackBase = `cunote-draft-${draft.id.slice(0, 8)}`;
    return binaryDownloadResponse({
      body: result.body,
      filename: `창업노트-${filenameBase}-${draft.id.slice(0, 8)}.hwpx`,
      fallbackFilename: `${fallbackBase}.hwpx`,
      contentType: "application/hwp+zip",
      extraHeaders: {
        "X-Cunote-Hwpx-Unfilled": encodeURIComponent(JSON.stringify(result.unfilled.slice(0, 20))),
      },
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "draft_hwpx_download_failed",
      message: "원본 HWPX 양식에 값을 채워 다운로드하지 못했습니다.",
    });
  }
}

async function parseHwpxDownloadBody(request: Request): Promise<void> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DraftHwpxExportError("invalid_request_body", "요청 본문을 해석하지 못했습니다.", 400);
  }
  if (typeof body !== "object" || body === null) {
    throw new DraftHwpxExportError("invalid_request_body", "요청 본문이 올바르지 않습니다.", 400);
  }
  const record = body as Record<string, unknown>;
  if (record.format !== "hwpx") {
    throw new DraftHwpxExportError(
      "unsupported_format",
      "지원하지 않는 다운로드 형식입니다.",
      400,
      "format",
    );
  }
  // ADR-5: 클라이언트 answers 는 더 이상 채움에 반영하지 않는다(서버 저장 파생 filledFields 사용).
}
