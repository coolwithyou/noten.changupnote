import type { CompanyRecord, CompanyRole } from "@cunote/core";

export type CompanyAccessMode = "demo" | "session" | "token";
export type CompanyAccessPermission = "read" | "write";

export interface CompanyAccessResult {
  companyId: string;
  userId: string;
  role: CompanyRole;
  mode: CompanyAccessMode;
}

export class CompanyAccessForbiddenError extends Error {
  readonly status = 403;
  readonly code: string;
  readonly field = "companyId";

  constructor(
    message = "해당 회사에 접근할 권한이 없습니다.",
    code = "company_forbidden",
  ) {
    super(message);
    this.name = "CompanyAccessForbiddenError";
    this.code = code;
  }
}

export function resolveCompanyAccessFromRecords(input: {
  companies: CompanyRecord[];
  userId: string;
  mode: CompanyAccessMode;
  companyId?: string;
  permission?: CompanyAccessPermission;
}): CompanyAccessResult {
  const company = input.companyId
    ? input.companies.find((entry) => entry.id === input.companyId)
    : input.companies[0];

  if (!company) {
    throw new CompanyAccessForbiddenError(
      input.companyId ? "해당 회사에 접근할 권한이 없습니다." : "접근 가능한 회사가 없습니다.",
      input.companyId ? "company_forbidden" : "company_access_required",
    );
  }

  const role = company.role ?? "viewer";
  if (input.permission === "write" && !canWriteCompany(role)) {
    throw new CompanyAccessForbiddenError(
      "해당 회사 정보를 수정할 권한이 없습니다.",
      "company_write_forbidden",
    );
  }

  return {
    companyId: company.id,
    userId: input.userId,
    role,
    mode: input.mode,
  };
}

export function canWriteCompany(role: CompanyRole): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** 익명 데모는 고정된 회사의 읽기만 허용한다. 명시적인 로컬 mock만 쓰기를 허용한다. */
export function resolveDemoCompanyAccess(input: {
  userId: string;
  defaultCompanyId: string;
  companyId?: string;
  permission?: CompanyAccessPermission;
  allowMockWrite?: boolean;
}): CompanyAccessResult {
  if (input.companyId && input.companyId !== input.defaultCompanyId) {
    throw new CompanyAccessForbiddenError();
  }
  if (input.permission === "write" && !input.allowMockWrite) {
    throw new CompanyAccessForbiddenError("데모 정보는 수정할 수 없습니다.", "company_write_forbidden");
  }
  return {
    companyId: input.defaultCompanyId,
    userId: input.userId,
    role: input.allowMockWrite ? "owner" : "viewer",
    mode: "demo",
  };
}

export function resolveCompanyAccessWithFallback(input: {
  companies: CompanyRecord[];
  userId: string;
  companyId?: string;
  permission?: CompanyAccessPermission;
  selectedFromCookie: boolean;
}): CompanyAccessResult {
  const selection = {
    companies: input.companies,
    userId: input.userId,
    mode: "session" as const,
    ...(input.permission ? { permission: input.permission } : {}),
  };
  try {
    return resolveCompanyAccessFromRecords({
      ...selection,
      ...(input.companyId ? { companyId: input.companyId } : {}),
    });
  } catch (error) {
    // 쓰기 중 회사를 바꾸면 사용자가 선택하지 않은 회사의 정보를 수정하게 된다.
    if (!(error instanceof CompanyAccessForbiddenError)
      || error.code !== "company_forbidden"
      || !input.selectedFromCookie
      || input.permission === "write") throw error;
    return resolveCompanyAccessFromRecords(selection);
  }
}
