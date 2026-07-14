import type { CompanyPreviewRequest, CompanyPreviewResult } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { loadProductCompanyPreview } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    return appData<CompanyPreviewResult>(
      await loadProductCompanyPreview(body.bizNo ?? "", { asOf: new Date() }),
    );
  } catch (error) {
    return appErrorFromUnknown(error, "회사 정보를 확인하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<Partial<CompanyPreviewRequest>> {
  try {
    const parsed = await request.json() as CompanyPreviewRequest;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
