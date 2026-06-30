import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { billingStatementDownloadResponse, buildBillingStatement } from "@/lib/server/billing/billingStatement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const statement = await buildBillingStatement({ access, session });
    return billingStatementDownloadResponse(statement);
  } catch (error) {
    return webActionError<null>(error, {
      code: "billing_statement_download_failed",
      message: "청구 명세서를 다운로드하지 못했습니다.",
    });
  }
}
