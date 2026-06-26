import type { CompanyProfile } from "@cunote/contracts";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateCompanyRequest {
  profile?: CompanyProfile;
}

export async function GET(request: Request) {
  try {
    const session = await requireAppSession(request);
    const companies = await getServiceRepositories().companies.listUserCompanies(session.user.id);
    return appData({ companies });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAppSession(request);
    const body = await readBody(request);
    if (!body.profile || typeof body.profile !== "object") {
      return appError("invalid_company_profile", "profile이 필요합니다.", 400, "profile");
    }

    const company = await getServiceRepositories().companies.createCompany({
      userId: session.user.id,
      profile: body.profile,
    });
    return appData({ company }, { status: 201 });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 정보를 저장하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<CreateCompanyRequest> {
  try {
    const parsed = await request.json() as CreateCompanyRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
