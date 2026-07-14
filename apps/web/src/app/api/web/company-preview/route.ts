import type { ActionResult, CompanyPreviewRequest, CompanyPreviewResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { ProductProfileResolutionError } from "@/lib/server/productProfile/resolveProductCompanyProfile";
import { loadProductCompanyPreview, ServiceDataError } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 랜딩 상호명 확인 게이트. 익명 경로는 product resolver의 공개 fresh cache만 사용한다. */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const result = await loadProductCompanyPreview(body.bizNo ?? "", { asOf: new Date() });
    return NextResponse.json<ActionResult<CompanyPreviewResult>>({ ok: true, data: result });
  } catch (error) {
    if (error instanceof ServiceDataError || error instanceof ProductProfileResolutionError) {
      const responseError: NonNullable<ActionResult<CompanyPreviewResult>["error"]> = {
        code: error.code,
        message: error.message,
      };
      if (error.field) responseError.field = error.field;

      return NextResponse.json<ActionResult<CompanyPreviewResult>>({
        ok: false,
        error: responseError,
      }, { status: error.status });
    }

    const isInputError = error instanceof Error && /사업자번호/.test(error.message);
    const responseError: NonNullable<ActionResult<CompanyPreviewResult>["error"]> = {
      code: isInputError ? "invalid_biz_no" : "company_preview_failed",
      message: error instanceof Error ? error.message : "회사 정보를 확인하지 못했습니다.",
    };
    if (isInputError) responseError.field = "bizNo";

    return NextResponse.json<ActionResult<CompanyPreviewResult>>({
      ok: false,
      error: responseError,
    }, { status: isInputError ? 400 : 500 });
  }
}

async function readBody(request: Request): Promise<Partial<CompanyPreviewRequest>> {
  try {
    const parsed = await request.json() as CompanyPreviewRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
