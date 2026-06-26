import type { CompanyProfile } from "@cunote/contracts";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { DEMO_COMPANY_ID } from "@/lib/server/repositories/runtime";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateCompanyRequest {
  profile?: CompanyProfile;
}

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const companies = await getServiceRepositories().companies.listUserCompanies(access.userId);
    return appData({ companies });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireCompanyAccess();
    const body = await readBody(request);
    const fallback = await getServiceRepositories().companies.getDefaultCompanyProfile();
    const profile = await getServiceRepositories().companies.saveCompanyProfile({
      companyId: DEMO_COMPANY_ID,
      userId: access.userId,
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
