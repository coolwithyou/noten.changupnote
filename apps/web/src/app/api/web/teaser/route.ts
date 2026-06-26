import type { ActionResult, TeaserRequest, TeaserResult } from "@cunote/contracts";
import { buildTeaser } from "@cunote/core";
import { NextResponse } from "next/server";
import { loadServiceGrants } from "@/lib/server/serviceData";
import { resolveTeaserCompanyProfile } from "@/lib/server/teaser/resolveTeaserCompanyProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const asOf = new Date();
    const [company, grants] = await Promise.all([
      resolveTeaserCompanyProfile(body),
      loadServiceGrants({ asOf, limit: 40 }),
    ]);
    const data = buildTeaser({ company, grants, asOf });
    return NextResponse.json<ActionResult<TeaserResult>>({ ok: true, data });
  } catch (error) {
    const isInputError = error instanceof Error && /사업자번호/.test(error.message);
    const responseError: NonNullable<ActionResult<TeaserResult>["error"]> = {
      code: isInputError ? "invalid_biz_no" : "teaser_failed",
      message: error instanceof Error ? error.message : "1차 매칭 티저를 만들지 못했습니다.",
    };
    if (isInputError) responseError.field = "bizNo";

    return NextResponse.json<ActionResult<TeaserResult>>({
      ok: false,
      error: responseError,
    }, { status: isInputError ? 400 : 500 });
  }
}

async function readBody(request: Request): Promise<Partial<TeaserRequest>> {
  try {
    const parsed = await request.json() as TeaserRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
