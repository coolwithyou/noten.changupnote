import type { CompanyProfile } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";
import { DEMO_COMPANY_ID } from "@/lib/server/repositories/runtime";
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
    const fallback = await getServiceRepositories().companies.getDefaultCompanyProfile();
    const profile = await getServiceRepositories().companies.saveCompanyProfile({
      companyId: DEMO_COMPANY_ID,
      userId: session.user.id,
      profile: body.profile ?? fallback,
    });
    return appData({ company: { id: DEMO_COMPANY_ID, name: profile.name ?? "샘플 기업", profile } }, { status: 201 });
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
