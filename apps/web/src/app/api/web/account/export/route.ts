import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { buildAccountDataExport } from "@/lib/server/account/accountDataExport";
import { textDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [access, session] = await Promise.all([
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const dataExport = await buildAccountDataExport({ access, session });

    return textDownloadResponse({
      body: dataExport.json,
      filename: dataExport.filename,
      fallbackFilename: dataExport.fallbackFilename,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "account_export_failed",
      message: "계정 데이터를 내보내지 못했습니다.",
    });
  }
}
