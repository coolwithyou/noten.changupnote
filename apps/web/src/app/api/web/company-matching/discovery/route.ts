import { NextResponse } from "next/server";
import { discoveryListSchema, selectDiscoveryPage } from "@/lib/matches/discoverySelections";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadProductDashboard } from "@/lib/server/serviceData";
import { DiscoverySelectionError, loadDiscoverySelections, saveDiscoverySelection } from "@/lib/server/matches/discoverySelections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const parsed = discoveryListSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new DiscoverySelectionError("invalid_discovery_query", "조회 범위를 확인해 주세요.", 400);
    const access = await requireCompanyAccess();
    // 데모/현재 회사 권한을 확인한 뒤 전체 활성 집합을 계산한다. 유료 조회·match_state 쓰기 없음.
    await loadDiscoverySelections(access);
    const asOf = new Date();
    const dashboard = await loadProductDashboard({ companyId: access.companyId, userId: access.userId, asOf, limit: Number.MAX_SAFE_INTEGER });
    const current = await loadDiscoverySelections(access);
    return NextResponse.json({ ok: true, data: { ...selectDiscoveryPage(dashboard.matches, current.selections, parsed.data, asOf), canWrite: current.canWrite } }, { headers });
  } catch (error) {
    return webActionError(error, { code: "discovery_read_failed", message: "탐색 목록을 불러오지 못했습니다." });
  }
}
export async function PUT(request: Request) {
  try {
    const access = await requireCompanyAccess({ permission: "write" });
    const data = await saveDiscoverySelection(access, await request.json());
    return NextResponse.json({ ok: true, data }, { headers });
  } catch (error) {
    return webActionError(error, { code: "discovery_save_failed", message: "탐색 목록을 저장하지 못했습니다." });
  }
}
