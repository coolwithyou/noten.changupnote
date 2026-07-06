import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import type {
  BusinessLookupRecordResult,
  BusinessLookupSuggestionsResult,
} from "@/lib/businessLookupSuggestions";
import {
  listBusinessLookupSuggestionsForSession,
  recordBusinessLookupForSession,
} from "@/lib/server/landing/businessLookupSuggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await listBusinessLookupSuggestionsForSession();
    return NextResponse.json<ActionResult<BusinessLookupSuggestionsResult>>({ ok: true, data });
  } catch (error) {
    return NextResponse.json<ActionResult<BusinessLookupSuggestionsResult>>({
      ok: false,
      error: {
        code: "business_lookup_suggestions_failed",
        message: error instanceof Error ? error.message : "최근 조회 사업자를 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const data = await recordBusinessLookupForSession(body.bizNo);
    return NextResponse.json<ActionResult<BusinessLookupRecordResult>>({ ok: true, data }, { status: 202 });
  } catch (error) {
    const isInputError = error instanceof Error && /사업자번호/.test(error.message);
    const responseError: NonNullable<ActionResult<BusinessLookupRecordResult>["error"]> = {
      code: isInputError ? "invalid_biz_no" : "business_lookup_record_failed",
      message: error instanceof Error ? error.message : "조회한 사업자를 저장하지 못했습니다.",
    };
    if (isInputError) responseError.field = "bizNo";
    return NextResponse.json<ActionResult<BusinessLookupRecordResult>>({
      ok: false,
      error: responseError,
    }, { status: isInputError ? 400 : 500 });
  }
}

async function readBody(request: Request): Promise<{ bizNo: string }> {
  try {
    const parsed = await request.json() as { bizNo?: unknown };
    return {
      bizNo: typeof parsed.bizNo === "string" ? parsed.bizNo : "",
    };
  } catch {
    return { bizNo: "" };
  }
}
