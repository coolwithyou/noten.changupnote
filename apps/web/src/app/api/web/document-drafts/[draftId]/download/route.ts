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
 * HWPX 원본 양식 채움 다운로드 (설계 결정 6·8, Phase 2).
 * GET(markdown/html/docx/pdf)과 달리 워크스페이스 추가 입력(answers)을 body 로 동봉받아
 * `{...draft.filledFields, ...answers}`(answers 우선)로 원본 .hwpx 보관본을 채워 반환한다.
 * 미채움 라벨은 X-Cunote-Hwpx-Unfilled 헤더로 클라이언트에 전달한다.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const payload = await parseHwpxDownloadBody(request);

    // 읽기로 초안을 먼저 확보한 뒤 채움을 시도하고, 성공했을 때만 export 이력을 남긴다
    // (위장 파일 등으로 실패한 다운로드를 내보냄으로 기록하지 않기 위함).
    const draft = await getGrantDocumentDraft({ draftId, access });
    const result = await buildDraftHwpxDownload({
      draft,
      ...(payload.answers ? { answers: payload.answers } : {}),
    });
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

async function parseHwpxDownloadBody(
  request: Request,
): Promise<{ answers?: Record<string, string> }> {
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
  const answers = normalizeAnswers(record.answers);
  return answers ? { answers } : {};
}

function normalizeAnswers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const label = key.trim().slice(0, 160);
    const filled = raw.trim().slice(0, 4000);
    if (label && filled) result[label] = filled;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
