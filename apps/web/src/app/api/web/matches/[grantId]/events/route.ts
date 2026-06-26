import type { ActionResult, MatchEventResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  buildMatchEventResult,
  buildSaveMatchEventInput,
  decodeGrantIdSegment,
  readMatchEventRequest,
} from "@/lib/server/matches/matchEvents";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ grantId }, body, access] = await Promise.all([
      context.params,
      readMatchEventRequest(request),
      requireCompanyAccess({ permission: "write" }),
    ]);
    const decodedGrantId = decodeGrantIdSegment(grantId);
    const input = buildSaveMatchEventInput({
      companyId: access.companyId,
      grantId: decodedGrantId,
      userId: access.userId,
      body,
    });
    const receipt = await getServiceRepositories().matches.saveMatchEvent(input);

    return NextResponse.json<ActionResult<MatchEventResult>>({
      ok: true,
      data: buildMatchEventResult({ event: input, receipt }),
    }, { status: 202 });
  } catch (error) {
    return webActionError<MatchEventResult>(error, {
      code: "match_event_failed",
      message: "매칭 이벤트를 기록하지 못했습니다.",
    });
  }
}
