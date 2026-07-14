import type { ActionResult, TeaserRequest } from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { writeSelectedCompanyId } from "@/lib/server/auth/companySelection";
import { AuthRequiredError, getOptionalWebSession, isAuthEnforced } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories, resolveAnonymousProductCompanyProfile } from "@/lib/server/serviceData";
import { mockUserId } from "@/lib/server/auth/mockIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebCompaniesResult {
  currentCompanyId: string;
  companies: CompanyRecord[];
}

interface WebCompanyCreateResult {
  currentCompanyId: string;
  company: CompanyRecord;
}

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const companies = await getServiceRepositories().companies.listUserCompanies(access.userId);
    return NextResponse.json<ActionResult<WebCompaniesResult>>({
      ok: true,
      data: {
        currentCompanyId: access.companyId,
        companies,
      },
    });
  } catch (error) {
    return webActionError<WebCompaniesResult>(error, {
      code: "companies_failed",
      message: "회사 목록을 불러오지 못했습니다.",
    });
  }
}

export async function POST(request: Request) {
  try {
    const [userId, body] = await Promise.all([
      resolveCreateCompanyUserId(),
      readCreateBody(request),
    ]);
    const resolution = await resolveAnonymousProductCompanyProfile(body, { asOf: new Date() });
    const company = await getServiceRepositories().companies.createCompany({
      userId,
      profile: resolution.profile,
    });

    const response = NextResponse.json<ActionResult<WebCompanyCreateResult>>({
      ok: true,
      data: {
        currentCompanyId: company.id,
        company,
      },
    }, { status: 201 });
    writeSelectedCompanyId(response, company.id);
    return response;
  } catch (error) {
    return webActionError<WebCompanyCreateResult>(error, {
      code: "company_create_failed",
      message: "회사 프로필을 저장하지 못했습니다.",
    });
  }
}

async function resolveCreateCompanyUserId(): Promise<string> {
  const session = await getOptionalWebSession();
  if (session) return session.user.id;
  if (isAuthEnforced()) throw new AuthRequiredError();
  return mockUserId();
}

async function readCreateBody(request: Request): Promise<Partial<TeaserRequest>> {
  try {
    const parsed = await request.json() as Partial<TeaserRequest>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
