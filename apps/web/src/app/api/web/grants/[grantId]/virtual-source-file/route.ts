import { webActionError } from "@/lib/server/auth/webActionError";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { DraftSourceFileError, loadDraftSourceFile } from "@/lib/server/documents/draftSourceFile";
import { loadServiceApplySheet } from "@/lib/server/serviceData";
import { resolveVirtualCompanyGrantAccess } from "@/lib/server/virtualCompanies/grantAccess";
import {
  buildGrantSimulationCompanyProfile,
  getGrantSimulationAdminIdentity,
} from "@/lib/server/adminGrantSimulation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ grantId: string }>;
}

/**
 * 가상 기업 RHWP 미리보기용 원본 HWP/HWPX 읽기 전용 경계.
 *
 * 클라이언트는 storage key나 파일명을 선택하지 못한다. 등록된 가상 기업의 정확한 목표 공고와
 * ApplySheet의 documentKey를 서버에서 다시 결속한 뒤, 그 문서에 연결된 원본만 반환한다.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const search = new URL(request.url).searchParams;
    const documentKey = search.get("document")?.trim() ?? "";
    const adminIdentity = search.get("adminPreview") === "1"
      ? await getGrantSimulationAdminIdentity()
      : null;
    const scenario = await resolveVirtualCompanyGrantAccess({
      grantId,
      bizNo: search.get("biz"),
    });
    if (!scenario && !adminIdentity) {
      throw new DraftSourceFileError("virtual_company_grant_not_found", "원본 양식을 찾지 못했습니다.", 404);
    }
    if (!documentKey) {
      throw new DraftSourceFileError("virtual_document_required", "작성할 서류를 선택해 주세요.", 400);
    }

    const sheet = adminIdentity
      ? await loadServiceApplySheet(grantId, { simulationProfile: buildGrantSimulationCompanyProfile() })
      : await loadServiceApplySheet(grantId, { virtualBizNo: scenario!.bizNo });
    const document = sheet?.applicationPrep.draftableDocuments.find(
      (candidate) => candidate.documentKey === documentKey,
    );
    if (!sheet || !document) {
      throw new DraftSourceFileError("virtual_document_not_found", "작성할 서류를 찾지 못했습니다.", 404);
    }

    const source = await loadDraftSourceFile({
      draft: { grantId: sheet.grant.id, sourceAttachment: document.sourceAttachment },
    });
    const filename = sanitizeDownloadFilename(source.filename, `cunote-virtual-${grantId.slice(0, 8)}`);
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
        "x-cunote-preview-mode": "local-only",
      },
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "virtual_document_source_load_failed",
      message: "가상 기업용 원본 HWP/HWPX 양식을 불러오지 못했습니다.",
    });
  }
}
