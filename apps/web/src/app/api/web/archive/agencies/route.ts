import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  searchGrantAgencies,
  type GrantAgencySearchResult,
} from "@/lib/server/archive/grantArchiveData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// 아카이브 기능 일시 숨김(2026-07-23) — 복원 시 이 플래그만 제거.
const ARCHIVE_HIDDEN: boolean = true;

export async function GET(request: Request) {
  if (ARCHIVE_HIDDEN) return new NextResponse(null, { status: 404 });
  try {
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() || undefined;
    const limit = parseLimit(params.get("limit"));
    if (limit === "invalid") {
      return NextResponse.json<ActionResult<GrantAgencySearchResult>>({
        ok: false,
        error: {
          code: "invalid_archive_query",
          message: `limit은 1 이상 ${MAX_LIMIT} 이하의 정수여야 합니다.`,
          field: "limit",
        },
      }, { status: 400 });
    }

    await requireCompanyAccess();
    const data = await searchGrantAgencies(q ? { q, limit } : { limit });
    return NextResponse.json<ActionResult<GrantAgencySearchResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<GrantAgencySearchResult>(error, {
      code: "grant_archive_agencies_failed",
      message: "주관기관 자동완성을 불러오지 못했습니다.",
    });
  }
}

function parseLimit(raw: string | null): number | "invalid" {
  if (!raw) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return "invalid";
  return value;
}
