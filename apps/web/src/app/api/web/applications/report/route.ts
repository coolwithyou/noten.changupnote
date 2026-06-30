import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  applicationPipelineReportDownloadResponse,
  buildApplicationPipelineReport,
} from "@/lib/server/applications/applicationPipelineReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const report = await buildApplicationPipelineReport({ access });
    return applicationPipelineReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_pipeline_report_failed",
      message: "신청 파이프라인 리포트를 다운로드하지 못했습니다.",
    });
  }
}
