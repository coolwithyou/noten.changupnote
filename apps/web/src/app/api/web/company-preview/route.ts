import type { ActionResult, CompanyPreviewRequest, CompanyPreviewResult } from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import { maskCorpNum } from "@cunote/core";
import { NextResponse } from "next/server";
import { loadCompanyProfileResolutionForTeaser, ServiceDataError } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 랜딩 상호명 확인 게이트: 매칭 티저(과금 후 무거운 계산) 전에 회사 정보만 가볍게 확인한다.
 * loadCompanyProfileResolutionForTeaser 를 재사용하므로 저장 프로필 → 팝빌 캐시 → NTS 사전 게이트 →
 * 팝빌 라이브 순서가 그대로 적용된다. 여기서 과금이 발생해도 30일 캐시에 저장되어 이어지는 티저는 추가 과금이 없다.
 */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const bizNo = body.bizNo?.trim();
    if (!bizNo || !isValidBizNoChecksum(bizNo)) {
      return NextResponse.json<ActionResult<CompanyPreviewResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
          field: "bizNo",
        },
      }, { status: 400 });
    }

    const { profile, evidence } = await loadCompanyProfileResolutionForTeaser(bizNo);

    const businessStatus: NonNullable<CompanyPreviewResult["businessStatus"]> = {};
    if (typeof profile.business_status?.active === "boolean") {
      businessStatus.active = profile.business_status.active;
    }
    if (profile.business_status?.label) {
      businessStatus.label = profile.business_status.label;
    }

    const result: CompanyPreviewResult = {
      name: profile.name ?? null,
      maskedBizNo: maskCorpNum(bizNo),
    };
    if (Object.keys(businessStatus).length > 0) result.businessStatus = businessStatus;
    const regionLabel = profile.region?.label ?? profile.region?.code;
    if (regionLabel) result.regionLabel = regionLabel;
    if (evidence?.checkedAt) result.checkedAt = evidence.checkedAt;
    if (evidence?.cacheStatus) result.cacheStatus = evidence.cacheStatus;

    return NextResponse.json<ActionResult<CompanyPreviewResult>>({ ok: true, data: result });
  } catch (error) {
    if (error instanceof ServiceDataError) {
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
