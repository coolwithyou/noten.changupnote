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
