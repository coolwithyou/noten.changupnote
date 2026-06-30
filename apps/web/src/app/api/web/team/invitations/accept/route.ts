import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  acceptTeamInvitation,
  type TeamInvitationAcceptance,
} from "@/lib/server/team/teamManagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const body = await request.json() as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";
    const acceptance = await acceptTeamInvitation({ token, session });
    return NextResponse.json<ActionResult<TeamInvitationAcceptance>>({ ok: true, data: acceptance });
  } catch (error) {
    return webActionError<TeamInvitationAcceptance>(error, {
      code: "team_invitation_accept_failed",
      message: "팀 초대를 수락하지 못했습니다.",
    });
  }
}
