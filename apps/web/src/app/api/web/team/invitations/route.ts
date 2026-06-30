import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  createTeamInvitation,
  isTeamManagedRole,
  type TeamInvitationRecord,
} from "@/lib/server/team/teamManagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await requireCompanyAccess({ permission: "write" });
    const body = await request.json() as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email : "";
    const role = isTeamManagedRole(body.role) ? body.role : "member";
    const invitation = await createTeamInvitation({
      access,
      email,
      role,
      origin: requestOrigin(request),
    });
    return NextResponse.json<ActionResult<TeamInvitationRecord>>(
      { ok: true, data: invitation },
      { status: invitation.persisted ? 201 : 202 },
    );
  } catch (error) {
    return webActionError<TeamInvitationRecord>(error, {
      code: "team_invitation_failed",
      message: "팀 초대를 만들지 못했습니다.",
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
