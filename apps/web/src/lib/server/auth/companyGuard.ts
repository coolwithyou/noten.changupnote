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
import { headers } from "next/headers";
import { requestCompanyScope } from "./requestCompanyScope";
import { COMPANY_CONTEXT_HEADER } from "@/lib/navigation/companyContext";

export interface CompanyAccessOptions {
  companyId?: string;
  permission?: CompanyAccessPermission;
}

export type CompanyAccess = CompanyAccessResult;

export async function requireCompanyAccess(options: CompanyAccessOptions = {}): Promise<CompanyAccess> {
  const headerCompanyId = await readRequestCompanyId();
  const explicitCompanyId = options.companyId ?? headerCompanyId;
  if (options.companyId && headerCompanyId !== undefined && options.companyId !== headerCompanyId) {
    requestCompanyScope(null); // 두 명시적 문맥이 다르면 어느 쪽도 임의 선택하지 않는다.
  }
  const selectedCompanyId = explicitCompanyId ?? await readSelectedCompanyId();
  const selectedFromCookie = explicitCompanyId === undefined && Boolean(selectedCompanyId);
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

async function readRequestCompanyId(): Promise<string | undefined> {
  let value: string | null;
  try { value = (await headers()).get(COMPANY_CONTEXT_HEADER); }
  catch { return undefined; } // CLI/오프라인 adapter에는 Next 요청 문맥이 없다.
  return value === null ? undefined : requestCompanyScope(value).companyId;
}

function isDefaultMockSession(userId: string): boolean {
  return isMockAuthEnabled()
    && userId === mockUserId();
}
