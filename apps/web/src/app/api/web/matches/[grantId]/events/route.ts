import type { ActionResult, MatchEventKind, MatchEventRequest, MatchEventResult } from "@cunote/contracts";
import type { SaveMatchEventInput } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
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
      readBody(request),
      requireCompanyAccess({ permission: "write" }),
    ]);
    const decodedGrantId = decodeGrantIdSegment(grantId);
    const event = normalizeEvent(body.event ?? body.type);
    const input: SaveMatchEventInput = {
      companyId: access.companyId,
      grantId: decodedGrantId,
      event,
      userId: access.userId,
    };
    if (body.rulesetVer) input.rulesetVer = body.rulesetVer;
    const receipt = await getServiceRepositories().matches.saveMatchEvent(input);

    return NextResponse.json<ActionResult<MatchEventResult>>({
      ok: true,
      data: {
        accepted: true,
        companyId: access.companyId,
        grantId: decodedGrantId,
        event,
        receipt,
      },
    }, { status: 202 });
  } catch (error) {
    return webActionError<MatchEventResult>(error, {
      code: "match_event_failed",
      message: "매칭 이벤트를 기록하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<MatchEventRequest> {
  try {
    const parsed = await request.json() as MatchEventRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeEvent(value: MatchEventKind | undefined): MatchEventKind {
  if (value === "surfaced" || value === "clicked" || value === "saved" || value === "apply_click") {
    return value;
  }
  return "clicked";
}

function decodeGrantIdSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
