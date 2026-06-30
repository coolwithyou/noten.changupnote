import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  ApplicationReminderEmailHandoffError,
  applicationReminderEmailHandoffDownloadResponse,
  buildApplicationReminderEmailHandoff,
} from "@/lib/server/applications/applicationReminderEmailHandoff";

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
    const session = await getOptionalWebSession();
    const handoff = await buildApplicationReminderEmailHandoff({
      grantId,
      access,
      session,
      origin: new URL(request.url).origin,
    });

    return applicationReminderEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof ApplicationReminderEmailHandoffError) {
      return webActionError<null>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<null>(error, {
      code: "application_reminder_email_failed",
      message: "신청 리마인더 메일 파일을 만들지 못했습니다.",
    });
  }
}
