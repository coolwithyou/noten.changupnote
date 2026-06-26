import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
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
  params: Promise<{ companyId: string; grantId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId, grantId }, body] = await Promise.all([context.params, readMatchEventRequest(request)]);
    const access = await requireAppCompanyAccess(request, companyId);
    const input = buildSaveMatchEventInput({
      companyId,
      grantId: decodeGrantIdSegment(grantId),
      userId: access.userId,
      body,
    });
    const receipt = await getServiceRepositories().matches.saveMatchEvent(input);

    return appData(buildMatchEventResult({ event: input, receipt }), { status: 202 });
  } catch (error) {
    return appErrorFromUnknown(error, "매칭 이벤트를 기록하지 못했습니다.");
  }
}
