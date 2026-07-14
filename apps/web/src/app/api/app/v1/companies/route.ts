import type { TeaserRequest } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";
import { getServiceRepositories, resolveAnonymousProductCompanyProfile } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const resolution = await resolveAnonymousProductCompanyProfile(body, { asOf: new Date() });
    const company = await getServiceRepositories().companies.createCompany({
      userId: session.user.id,
      profile: resolution.profile,
    });
    return appData({ company }, { status: 201 });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 정보를 저장하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<Partial<TeaserRequest>> {
  try {
    const parsed = await request.json() as Partial<TeaserRequest>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
