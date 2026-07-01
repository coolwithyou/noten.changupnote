import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadGrantArchiveFacets } from "@/lib/server/archive/grantArchiveData";
import { parseGrantArchiveQuery } from "@/lib/server/archive/grantArchiveQuery";
import type { GrantArchiveFacets } from "@/lib/server/archive/grantArchiveSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const parsedQuery = parseGrantArchiveQuery(request);
    if (!parsedQuery.ok) {
      const { code, message, field, status } = parsedQuery.error;
      return NextResponse.json<ActionResult<GrantArchiveFacets>>({
        ok: false,
        error: { code, message, field },
      }, { status });
    }

    const access = await requireCompanyAccess();
    const data = await loadGrantArchiveFacets({ access, query: parsedQuery.query });
    return NextResponse.json<ActionResult<GrantArchiveFacets>>({ ok: true, data });
  } catch (error) {
    return webActionError<GrantArchiveFacets>(error, {
      code: "grant_archive_facets_failed",
      message: "지원사업 아카이브 필터 집계를 불러오지 못했습니다.",
    });
  }
}
