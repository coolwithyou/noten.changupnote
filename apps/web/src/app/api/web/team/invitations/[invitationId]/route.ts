import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { revokeTeamInvitation, type TeamInvitationRecord } from "@/lib/server/team/teamManagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    invitationId: string;
  }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { invitationId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const invitation = await revokeTeamInvitation({ access, invitationId });
    return NextResponse.json<ActionResult<TeamInvitationRecord>>({
      ok: true,
      data: invitation,
    });
  } catch (error) {
    return webActionError<TeamInvitationRecord>(error, {
      code: "team_invitation_revoke_failed",
      message: "초대를 철회하지 못했습니다.",
    });
  }
}
