import { buildAccountSecurityReport, accountSecurityReportDownloadResponse } from "@/lib/server/account/accountSecurityReport";
import { loadAccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const status = await loadAccountSecurityStatus({ access, session });
    const report = buildAccountSecurityReport({ access, status });
    return accountSecurityReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "account_security_report_failed",
      message: "계정 보안 리포트를 다운로드하지 못했습니다.",
    });
  }
}
