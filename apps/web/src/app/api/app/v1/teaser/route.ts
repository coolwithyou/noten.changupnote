import type { TeaserRequest, TeaserResult } from "@cunote/contracts";
import { buildTeaser } from "@cunote/core";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { loadServiceGrants, ServiceDataError } from "@/lib/server/serviceData";
import { resolveTeaserCompanyProfileWithEvidence } from "@/lib/server/teaser/resolveTeaserCompanyProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const asOf = new Date();
    const [companyResolution, grants] = await Promise.all([
      resolveTeaserCompanyProfileWithEvidence(body),
      loadServiceGrants({ asOf, limit: 40 }),
    ]);
    return appData<TeaserResult>(buildTeaser({
      company: companyResolution.profile,
      grants,
      asOf,
      companyEvidence: companyResolution.evidence,
    }));
  } catch (error) {
    if (error instanceof ServiceDataError) {
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
