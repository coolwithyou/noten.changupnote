import { DEMO_COMPANY_ID } from "@/lib/server/repositories/runtime";
import { AuthRequiredError, getOptionalWebSession, isAuthEnforced } from "./session";

export interface CompanyAccess {
  companyId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  mode: "demo" | "session";
}

export async function requireCompanyAccess(companyId = DEMO_COMPANY_ID): Promise<CompanyAccess> {
  const session = await getOptionalWebSession();
  if (session) {
    return {
      companyId,
      userId: session.user.id,
      role: "owner",
      mode: "session",
    };
  }

  if (isAuthEnforced()) {
    throw new AuthRequiredError();
  }

  return {
    companyId: DEMO_COMPANY_ID,
    userId: "demo-user",
    role: "owner",
    mode: "demo",
  };
}
