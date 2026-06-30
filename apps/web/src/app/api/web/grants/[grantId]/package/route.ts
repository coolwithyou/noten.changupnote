import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { buildGrantApplicationPackage, buildGrantAttachmentBundle } from "@/lib/server/documents/applicationPackageExport";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const access = await requireCompanyAccess();
    const format = new URL(request.url).searchParams.get("format");

    if (format === "attachments") {
      const bundle = await buildGrantAttachmentBundle({ grantId, access });
      return markdownDownloadResponse({
        markdown: bundle.markdown,
        filename: bundle.filename,
        fallbackFilename: bundle.fallbackFilename,
      });
    }

    const grantPackage = await buildGrantApplicationPackage({ grantId, access });

    return markdownDownloadResponse({
      markdown: grantPackage.markdown,
      filename: grantPackage.filename,
      fallbackFilename: grantPackage.fallbackFilename,
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_package_download_failed",
      message: "신청 패키지를 다운로드하지 못했습니다.",
    });
  }
}
