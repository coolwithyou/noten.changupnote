import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  buildTeamInvitationEmailHandoff,
  TeamInvitationEmailHandoffError,
  teamInvitationEmailHandoffDownloadResponse,
} from "@/lib/server/team/teamInvitationEmailHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    token: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { token } = await context.params;
    const handoff = await buildTeamInvitationEmailHandoff({
      token,
      origin: new URL(request.url).origin,
    });
    return teamInvitationEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof TeamInvitationEmailHandoffError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        },
      }, { status: error.status });
    }
    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: {
        code: "team_invitation_email_handoff_failed",
        message: "팀 초대 메일 파일을 다운로드하지 못했습니다.",
      },
    }, { status: 500 });
  }
}
