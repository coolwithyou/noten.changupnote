import type { CompanyVerificationResult } from "@cunote/contracts";
import { maskCorpNum, sanitizeCorpNum } from "@cunote/core";
import { appData, appError, appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

interface CompanyVerificationRequest {
  bizNo?: string;
  ownerName?: string;
  openedOn?: string;
}

export async function POST(request: Request, context: RouteContext) {
  if (!isCompanyVerificationAllowed()) {
    return appNotImplemented("국세청 사업자 진위확인");
  }

  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!body.bizNo?.trim()) return appError("invalid_biz_no", "bizNo가 필요합니다.", 400, "bizNo");

    let bizNo: string;
    try {
      bizNo = sanitizeCorpNum(body.bizNo);
    } catch (error) {
      return appError("invalid_biz_no", error instanceof Error ? error.message : "사업자번호가 올바르지 않습니다.", 400, "bizNo");
    }

    const verification = await getServiceRepositories().companies.verifyCompany({
      companyId,
      userId: access.userId,
      bizNo,
      ...(body.ownerName ? { ownerName: body.ownerName } : {}),
      ...(body.openedOn ? { openedOn: body.openedOn } : {}),
      verifyMethod: "dev_self_declared",
    });
    const result: CompanyVerificationResult = {
      companyId: verification.companyId,
      bizNoMasked: maskCorpNum(verification.bizNo),
      verified: verification.verified,
      verifiedAt: verification.verifiedAt,
      verifyMethod: verification.verifyMethod,
    };
    return appData(result);
  } catch (error) {
    return appErrorFromUnknown(error, "회사 소유권 검증을 처리하지 못했습니다.");
  }
}

function isCompanyVerificationAllowed(): boolean {
  return (
    process.env.CUNOTE_AUTH_MODE === "mock" ||
    process.env.CUNOTE_COMPANY_VERIFY_ALLOW_DEV === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

async function readBody(request: Request): Promise<CompanyVerificationRequest> {
  try {
    const parsed = await request.json() as CompanyVerificationRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
