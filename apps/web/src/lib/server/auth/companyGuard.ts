import { AuthRequiredError, getOptionalWebSession, isAuthEnforced } from "./session";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { demoCompanyId } from "@/lib/server/repositories/runtime";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
  type CompanyAccessPermission,
  type CompanyAccessResult,
} from "./companyAccessPolicy";
import { readSelectedCompanyId } from "./companySelection";
import { mockUserId } from "./mockIdentity";

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
      return requireDemoCompanyAccess({
        userId: session.user.id,
        selectedFromCookie,
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

  return requireDemoCompanyAccess({
    userId: mockUserId(),
    selectedFromCookie,
    ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
  });
}

function requireDemoCompanyAccess(input: {
  userId: string;
  companyId?: string;
  permission?: CompanyAccessPermission;
  selectedFromCookie?: boolean;
}): CompanyAccess {
  const defaultCompanyId = demoCompanyId();
  const companyId = input.companyId ?? defaultCompanyId;
  if (companyId !== defaultCompanyId && !input.selectedFromCookie) {
    throw new CompanyAccessForbiddenError();
  }
  return {
    companyId: defaultCompanyId,
    userId: input.userId,
    role: "owner",
    mode: "demo",
  };
}

function resolveCompanyAccessWithFallback(input: {
  companies: Parameters<typeof resolveCompanyAccessFromRecords>[0]["companies"];
  userId: string;
  companyId?: string;
  permission?: CompanyAccessPermission;
  selectedFromCookie: boolean;
}): CompanyAccess {
  try {
    return resolveCompanyAccessFromRecords({
      companies: input.companies,
      userId: input.userId,
      mode: "session",
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.permission ? { permission: input.permission } : {}),
    });
  } catch (error) {
    if (!(error instanceof CompanyAccessForbiddenError) || !input.selectedFromCookie) throw error;
    return resolveCompanyAccessFromRecords({
      companies: input.companies,
      userId: input.userId,
      mode: "session",
      ...(input.permission ? { permission: input.permission } : {}),
    });
  }
}

function isDefaultMockSession(userId: string): boolean {
  return process.env.CUNOTE_AUTH_MODE === "mock"
    && userId === mockUserId();
}
