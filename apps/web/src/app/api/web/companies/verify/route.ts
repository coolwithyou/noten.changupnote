import type { ActionResult, CompanyVerificationRequest, CompanyVerificationResult } from "@cunote/contracts";
import { maskCorpNum, sanitizeCorpNum } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isCompanyVerificationAllowed()) {
    return NextResponse.json<ActionResult<CompanyVerificationResult>>({
      ok: false,
      error: {
        code: "not_implemented",
        message: "국세청 사업자 진위확인 연동이 필요합니다.",
      },
    }, { status: 501 });
  }

  try {
    const [access, body] = await Promise.all([
      requireCompanyAccess({ permission: "write" }),
      readBody(request),
    ]);
    if (!body.bizNo?.trim()) {
      return NextResponse.json<ActionResult<CompanyVerificationResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: "bizNo가 필요합니다.",
          field: "bizNo",
        },
      }, { status: 400 });
    }

    let bizNo: string;
    try {
      bizNo = sanitizeCorpNum(body.bizNo);
    } catch (error) {
      return NextResponse.json<ActionResult<CompanyVerificationResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: error instanceof Error ? error.message : "사업자번호가 올바르지 않습니다.",
          field: "bizNo",
        },
      }, { status: 400 });
    }

    const verification = await getServiceRepositories().companies.verifyCompany({
      companyId: access.companyId,
      userId: access.userId,
      bizNo,
      ...(body.ownerName ? { ownerName: body.ownerName } : {}),
      ...(body.openedOn ? { openedOn: body.openedOn } : {}),
      verifyMethod: "dev_self_declared",
    });
    const data: CompanyVerificationResult = {
      companyId: verification.companyId,
      bizNoMasked: maskCorpNum(verification.bizNo),
      verified: verification.verified,
      verifiedAt: verification.verifiedAt,
      verifyMethod: verification.verifyMethod,
    };
    return NextResponse.json<ActionResult<CompanyVerificationResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<CompanyVerificationResult>(error, {
      code: "company_verification_failed",
      message: "회사 소유권 검증을 처리하지 못했습니다.",
    });
  }
}

function isCompanyVerificationAllowed(): boolean {
  return (
    process.env.CUNOTE_AUTH_MODE === "mock" ||
    process.env.CUNOTE_COMPANY_VERIFY_ALLOW_DEV === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

async function readBody(request: Request): Promise<Partial<CompanyVerificationRequest>> {
  try {
    const parsed = await request.json() as CompanyVerificationRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
