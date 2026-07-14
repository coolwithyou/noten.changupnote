import type { ActionResult, ProductTeaserResult, TeaserRequest } from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { ProductProfileAnswerError } from "@/lib/server/productProfile/normalizeProductProfileAnswers";
import { ProductProfileResolutionError } from "@/lib/server/productProfile/resolveProductCompanyProfile";
import { loadProductTeaser, ServiceDataError } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    // API 직접 호출 방어: 사업자번호가 있으면 체크섬으로 명백한 무효 번호를 과금 전에 걸러낸다.
    const requestedBizNo = body.bizNo?.trim();
    if (requestedBizNo && !isValidBizNoChecksum(requestedBizNo)) {
      return NextResponse.json<ActionResult<ProductTeaserResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
          field: "bizNo",
        },
      }, { status: 400 });
    }
    const data = await loadProductTeaser(body);
    return NextResponse.json<ActionResult<ProductTeaserResult>>({ ok: true, data });
  } catch (error) {
    if (
      error instanceof ServiceDataError ||
      error instanceof ProductProfileResolutionError ||
      error instanceof ProductProfileAnswerError
    ) {
      const responseError: NonNullable<ActionResult<ProductTeaserResult>["error"]> = {
        code: error.code,
        message: error.message,
      };
      if (error.field) responseError.field = error.field;

      return NextResponse.json<ActionResult<ProductTeaserResult>>({
        ok: false,
        error: responseError,
      }, { status: error.status });
    }

    const isInputError = error instanceof Error && /사업자번호/.test(error.message);
    const responseError: NonNullable<ActionResult<ProductTeaserResult>["error"]> = {
      code: isInputError ? "invalid_biz_no" : "teaser_failed",
      message: error instanceof Error ? error.message : "1차 매칭 티저를 만들지 못했습니다.",
    };
    if (isInputError) responseError.field = "bizNo";

    return NextResponse.json<ActionResult<ProductTeaserResult>>({
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
