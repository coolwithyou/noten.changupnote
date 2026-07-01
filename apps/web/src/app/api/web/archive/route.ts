import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadGrantArchive } from "@/lib/server/archive/grantArchiveData";
import { parseGrantArchiveQuery } from "@/lib/server/archive/grantArchiveQuery";
import type { GrantArchiveResult } from "@/lib/server/archive/grantArchiveSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const parsedQuery = parseGrantArchiveQuery(request);
    if (!parsedQuery.ok) {
      const { code, message, field, status } = parsedQuery.error;
      return NextResponse.json<ActionResult<GrantArchiveResult>>({
        ok: false,
        error: { code, message, field },
      }, { status });
    }

    const access = await requireCompanyAccess();
    const data = await loadGrantArchive({ access, query: parsedQuery.query });
    return NextResponse.json<ActionResult<GrantArchiveResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<GrantArchiveResult>(error, {
      code: "grant_archive_failed",
      message: "지원사업 아카이브를 불러오지 못했습니다.",
    });
  }
}
