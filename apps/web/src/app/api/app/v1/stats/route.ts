import type { StatsResult } from "@cunote/contracts";
import { buildStats } from "@cunote/core";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { loadServiceGrants } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const asOf = new Date();
    const grants = await loadServiceGrants({ asOf, limit: 40 });
    return appData<StatsResult>(buildStats({ grants, asOf }));
  } catch (error) {
    return appErrorFromUnknown(error, "지원사업 집계를 불러오지 못했습니다.");
  }
}
