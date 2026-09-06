import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { requestCompanyScope } from "@/lib/server/auth/requestCompanyScope";
import { webActionError } from "@/lib/server/auth/webActionError";
import { productExposureEnabled, recordProductExposure } from "@/lib/server/productReadiness/exposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await requireWebSession();
    if (!productExposureEnabled()) return new NextResponse(null, { status: 204 });
    const raw = await request.text();
    if (raw.length > 3_000) return new NextResponse(null, { status: 413 });
    const body = JSON.parse(raw) as { companyId?: unknown; token?: unknown };
    const scope = requestCompanyScope(body?.companyId);
    if (!scope.companyId) return new NextResponse(null, { status: 400 });
    const access = await requireCompanyAccess({ ...scope, permission: "read" });
    await recordProductExposure({ token: body.token, companyId: access.companyId, userId: access.userId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return webActionError(error, { code: "exposure_failed", message: "노출 관측을 기록하지 못했습니다." });
  }
}
