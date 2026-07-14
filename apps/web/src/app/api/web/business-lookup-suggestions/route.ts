import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import type {
  BusinessLookupRecordResult,
  BusinessLookupDeleteResult,
  BusinessLookupSuggestionsResult,
} from "@/lib/businessLookupSuggestions";
import {
  listBusinessLookupSuggestionsForSession,
  deleteBusinessLookupForSession,
  recordBusinessLookupForSession,
} from "@/lib/server/landing/businessLookupSuggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await listBusinessLookupSuggestionsForSession();
    return NextResponse.json<ActionResult<BusinessLookupSuggestionsResult>>({ ok: true, data });
  } catch (error) {
    console.warn(`Business lookup suggestions endpoint failed: ${errorMessage(error)}`);
    return NextResponse.json<ActionResult<BusinessLookupSuggestionsResult>>({
      ok: true,
      data: {
        authenticated: false,
        suggestions: [],
      },
    });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const data = await recordBusinessLookupForSession(body.bizNo);
    return NextResponse.json<ActionResult<BusinessLookupRecordResult>>({ ok: true, data }, { status: 202 });
  } catch (error) {
    const isInputError = error instanceof Error && /사업자번호/.test(error.message);
    if (!isInputError) {
      console.warn(`Business lookup record endpoint failed: ${errorMessage(error)}`);
      return NextResponse.json<ActionResult<BusinessLookupRecordResult>>({
        ok: true,
        data: {
          authenticated: false,
          recorded: false,
          suggestion: null,
        },
      }, { status: 202 });
    }

    const responseError: NonNullable<ActionResult<BusinessLookupRecordResult>["error"]> = {
      code: "invalid_biz_no",
      message: error instanceof Error ? error.message : "조회한 사업자를 저장하지 못했습니다.",
    };
    responseError.field = "bizNo";
    return NextResponse.json<ActionResult<BusinessLookupRecordResult>>({
      ok: false,
      error: responseError,
    }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBody(request);
    const data = await deleteBusinessLookupForSession(body.bizNo);
    return NextResponse.json<ActionResult<BusinessLookupDeleteResult>>({ ok: true, data });
  } catch (error) {
    const responseError: NonNullable<ActionResult<BusinessLookupDeleteResult>["error"]> = {
      code: "invalid_biz_no",
      message: error instanceof Error ? error.message : "조회 목록에서 삭제하지 못했습니다.",
      field: "bizNo",
    };
    return NextResponse.json<ActionResult<BusinessLookupDeleteResult>>({
      ok: false,
      error: responseError,
    }, { status: 400 });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
