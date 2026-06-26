import { AuthRequiredError, getOptionalWebSession, isAuthEnforced } from "./session";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { DEMO_COMPANY_ID } from "@/lib/server/repositories/runtime";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
  type CompanyAccessPermission,
  type CompanyAccessResult,
} from "./companyAccessPolicy";

export interface CompanyAccessOptions {
  companyId?: string;
  permission?: CompanyAccessPermission;
}

export type CompanyAccess = CompanyAccessResult;

export async function requireCompanyAccess(options: CompanyAccessOptions = {}): Promise<CompanyAccess> {
  const session = await getOptionalWebSession();
  if (session) {
    if (isDefaultMockSession(session.user.id) && !isAuthEnforced()) {
      return requireDemoCompanyAccess(session.user.id, options.companyId, options.permission);
    }

    const companies = await getServiceRepositories().companies.listUserCompanies(session.user.id);
    return resolveCompanyAccessFromRecords({
      companies,
      userId: session.user.id,
      mode: "session",
      ...(options.companyId ? { companyId: options.companyId } : {}),
      ...(options.permission ? { permission: options.permission } : {}),
    });
  }

  if (isAuthEnforced()) {
    throw new AuthRequiredError();
  }

  return requireDemoCompanyAccess("demo-user", options.companyId, options.permission);
}

function requireDemoCompanyAccess(
  userId: string,
  companyId = DEMO_COMPANY_ID,
  permission: CompanyAccessPermission = "read",
): CompanyAccess {
  if (companyId !== DEMO_COMPANY_ID) {
    throw new CompanyAccessForbiddenError();
  }
  return {
    companyId: DEMO_COMPANY_ID,
    userId,
    role: "owner",
    mode: "demo",
  };
}

function isDefaultMockSession(userId: string): boolean {
  return process.env.CUNOTE_AUTH_MODE === "mock"
    && userId === (process.env.CUNOTE_MOCK_USER_ID ?? "demo-user");
}
