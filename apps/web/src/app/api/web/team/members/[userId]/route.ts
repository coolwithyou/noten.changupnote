import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  isTeamManagedRole,
  updateTeamMemberRole,
  type TeamMemberRoleUpdate,
} from "@/lib/server/team/teamManagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    userId: string;
  }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { userId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = await request.json() as Record<string, unknown>;
    if (!isTeamManagedRole(body.role)) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: "invalid_team_role",
          message: "변경할 역할을 확인해주세요.",
          field: "role",
        },
      }, { status: 400 });
    }
    const updated = await updateTeamMemberRole({
      access,
      targetUserId: userId,
      role: body.role,
    });
    return NextResponse.json<ActionResult<TeamMemberRoleUpdate>>({
      ok: true,
      data: updated,
    });
  } catch (error) {
    return webActionError<TeamMemberRoleUpdate>(error, {
      code: "team_member_update_failed",
      message: "멤버 역할을 저장하지 못했습니다.",
    });
  }
}
