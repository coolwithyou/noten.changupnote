import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { resendTeamInvitation, type TeamInvitationRecord } from "@/lib/server/team/teamManagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    invitationId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { invitationId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const invitation = await resendTeamInvitation({
      access,
      invitationId,
      origin: requestOrigin(request),
    });
    return NextResponse.json<ActionResult<TeamInvitationRecord>>({
      ok: true,
      data: invitation,
    });
  } catch (error) {
    return webActionError<TeamInvitationRecord>(error, {
      code: "team_invitation_resend_failed",
      message: "초대 링크를 재발행하지 못했습니다.",
    });
  }
}

function requestOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto = forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
