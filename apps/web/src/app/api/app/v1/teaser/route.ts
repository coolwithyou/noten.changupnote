import type { ProductTeaserResult, TeaserRequest } from "@cunote/contracts";
import { isValidBizNoChecksum } from "@cunote/contracts";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { ProductProfileAnswerError } from "@/lib/server/productProfile/normalizeProductProfileAnswers";
import { ProductProfileResolutionError } from "@/lib/server/productProfile/resolveProductCompanyProfile";
import { loadProductTeaser, ServiceDataError } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const requestedBizNo = body.bizNo?.trim();
    if (requestedBizNo && !isValidBizNoChecksum(requestedBizNo)) {
      return appError(
        "invalid_biz_no",
        "유효하지 않은 사업자등록번호입니다. 입력한 번호를 다시 확인해주세요.",
        400,
        "bizNo",
      );
    }
    return appData<ProductTeaserResult>(await loadProductTeaser(body));
  } catch (error) {
    if (
      error instanceof ServiceDataError ||
      error instanceof ProductProfileResolutionError ||
      error instanceof ProductProfileAnswerError
    ) {
      return appError(error.code, error.message, error.status, error.field);
    }
    if (error instanceof Error && /사업자번호/.test(error.message)) {
      return appError("invalid_biz_no", error.message, 400, "bizNo");
    }
    return appErrorFromUnknown(error, "1차 매칭 티저를 만들지 못했습니다.");
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
