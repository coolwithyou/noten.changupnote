import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadOnboardingProgress } from "@/lib/server/onboarding/onboardingProgress";
import { buildSettingsReport, settingsReportDownloadResponse } from "@/lib/server/settings/settingsReport";
import { loadWorkspaceOverview } from "@/lib/server/workspace/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const [progress, overview] = await Promise.all([
      loadOnboardingProgress({ access }),
      loadWorkspaceOverview({ access, session }),
    ]);
    const report = buildSettingsReport({ progress, overview });
    return settingsReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "settings_report_failed",
      message: "설정 리포트를 다운로드하지 못했습니다.",
    });
  }
}
