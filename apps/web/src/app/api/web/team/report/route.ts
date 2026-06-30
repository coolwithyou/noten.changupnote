import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  buildTeamOperationsReport,
  teamOperationsReportDownloadResponse,
} from "@/lib/server/team/teamOperationsReport";
import { loadWorkspaceOverview } from "@/lib/server/workspace/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const overview = await loadWorkspaceOverview({ access, session });
    const report = buildTeamOperationsReport({ overview });
    return teamOperationsReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "team_operations_report_failed",
      message: "팀 운영 리포트를 다운로드하지 못했습니다.",
    });
  }
}
