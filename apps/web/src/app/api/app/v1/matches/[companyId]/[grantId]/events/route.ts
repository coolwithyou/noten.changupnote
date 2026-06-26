import type { MatchEventKind } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string; grantId: string }>;
}

interface MatchEventRequest {
  event?: MatchEventKind;
  type?: MatchEventKind;
  rulesetVer?: string;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId, grantId }, body] = await Promise.all([context.params, readBody(request)]);
    await requireAppCompanyAccess(request, companyId);
    const event = normalizeEvent(body.event ?? body.type);
    const input: Parameters<ReturnType<typeof getServiceRepositories>["matches"]["saveMatchEvent"]>[0] = {
      companyId,
      grantId,
      event,
    };
    if (body.rulesetVer) input.rulesetVer = body.rulesetVer;
    const receipt = await getServiceRepositories().matches.saveMatchEvent(input);

    return appData({ accepted: true, companyId, grantId, event, receipt }, { status: 202 });
  } catch (error) {
    return appErrorFromUnknown(error, "매칭 이벤트를 기록하지 못했습니다.");
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
