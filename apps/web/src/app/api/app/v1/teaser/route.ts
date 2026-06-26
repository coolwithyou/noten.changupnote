import type { TeaserResult } from "@cunote/contracts";
import { buildTeaser } from "@cunote/core";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { loadCompanyProfileForTeaser, loadServiceGrants } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TeaserRequest {
  bizNo?: string;
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const asOf = new Date();
    const [company, grants] = await Promise.all([
      loadCompanyProfileForTeaser(body.bizNo?.trim() || undefined),
      loadServiceGrants({ asOf, limit: 40 }),
    ]);
    return appData<TeaserResult>(buildTeaser({ company, grants, asOf }));
  } catch (error) {
    if (error instanceof Error && /사업자번호/.test(error.message)) {
      return appError("invalid_biz_no", error.message, 400, "bizNo");
    }
    return appErrorFromUnknown(error, "1차 매칭 티저를 만들지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<TeaserRequest> {
  try {
    const parsed = await request.json() as TeaserRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
