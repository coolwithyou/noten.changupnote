/** 명시한 회사가 잘못됐으면 쿠키 회사로 후퇴하지 않는다. 미지정만 기존 쿠키 경로를 허용한다. */
export function requestCompanyScope(value: unknown): { companyId?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 128) {
    throw new InvalidCompanyScopeError();
  }
  return { companyId: value };
}

class InvalidCompanyScopeError extends Error {
  readonly status = 400;
  readonly code = "invalid_company_id";
  readonly field = "companyId";
  constructor() { super("회사 식별자를 확인해주세요."); }
}
