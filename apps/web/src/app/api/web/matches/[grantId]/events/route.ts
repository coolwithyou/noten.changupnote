import type { ActionResult, MatchEventResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requestCompanyScope } from "@/lib/server/auth/requestCompanyScope";
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
    const [{ grantId }, body] = await Promise.all([
      context.params,
      readMatchEventRequest(request),
    ]);
    const scope = requestCompanyScope(body.companyId);
    if (body.journey && !scope.companyId) return new NextResponse(null, { status: 400 });
    const access = await requireCompanyAccess({ ...scope, permission: "write" });
    // 마이그레이션·계측 인수 이후에만 활성화한다. 비활성은 저장 성공이 아니다.
    if (body.journey && process.env.CUNOTE_MATCH_JOURNEY_ENABLED !== "true") return new NextResponse(null, { status: 204 });
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
