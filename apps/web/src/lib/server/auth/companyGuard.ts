import { AuthRequiredError, getOptionalWebSession, isAuthEnforced } from "./session";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { demoCompanyId } from "@/lib/server/repositories/runtime";
import {
  resolveCompanyAccessWithFallback,
  resolveDemoCompanyAccess,
  type CompanyAccessPermission,
  type CompanyAccessResult,
} from "./companyAccessPolicy";
import { readSelectedCompanyId } from "./companySelection";
import { mockUserId } from "./mockIdentity";
import { isMockAuthEnabled } from "./runtimePolicy";

export interface CompanyAccessOptions {
  companyId?: string;
  permission?: CompanyAccessPermission;
}

export type CompanyAccess = CompanyAccessResult;

export async function requireCompanyAccess(options: CompanyAccessOptions = {}): Promise<CompanyAccess> {
  const selectedCompanyId = options.companyId ?? await readSelectedCompanyId();
  const selectedFromCookie = !options.companyId && Boolean(selectedCompanyId);
  const session = await getOptionalWebSession();
  if (session) {
    if (isDefaultMockSession(session.user.id) && !isAuthEnforced()) {
      return resolveDemoCompanyAccess({
        userId: session.user.id,
        defaultCompanyId: demoCompanyId(),
        allowMockWrite: true,
        ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
        ...(options.permission ? { permission: options.permission } : {}),
      });
    }

    const companies = await getServiceRepositories().companies.listUserCompanies(session.user.id);
    return resolveCompanyAccessWithFallback({
      companies,
      userId: session.user.id,
      selectedFromCookie,
      ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
      ...(options.permission ? { permission: options.permission } : {}),
    });
  }

  if (isAuthEnforced()) {
    throw new AuthRequiredError();
  }

  return resolveDemoCompanyAccess({
    userId: mockUserId(),
    defaultCompanyId: demoCompanyId(),
    ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
  });
}

function isDefaultMockSession(userId: string): boolean {
  return isMockAuthEnabled()
    && userId === mockUserId();
}
