import { redirect } from "next/navigation";
import { CompanyAccessForbiddenError } from "./companyAccessPolicy";
import { AuthRequiredError } from "./session";

export function redirectOnAuthRequired(error: unknown, callbackUrl: string): never {
  if (error instanceof AuthRequiredError) {
    const params = new URLSearchParams({ callbackUrl });
    redirect(`/login?${params.toString()}`);
  }
  if (error instanceof CompanyAccessForbiddenError && error.code === "company_access_required") {
    const params = new URLSearchParams({ next: callbackUrl });
    redirect(`/onboarding?${params.toString()}`);
  }
  throw error;
}
