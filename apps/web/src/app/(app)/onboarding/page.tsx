import { OnboardingPageView } from "@/features/onboarding/OnboardingPageView";
import { CompanyAccessForbiddenError } from "@/lib/server/auth/companyAccessPolicy";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { loadOnboardingProgress } from "@/lib/server/onboarding/onboardingProgress";

export const dynamic = "force-dynamic";

interface OnboardingPageProps {
  searchParams: Promise<{
    next?: string | string[];
  }>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const nextHref = normalizeNextHref(params.next);
  const access = await loadOnboardingAccess();
  const progress = access ? await loadOnboardingProgress({ access }) : null;
  return <OnboardingPageView progress={progress} nextHref={nextHref} />;
}

async function loadOnboardingAccess(): Promise<CompanyAccess | null> {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    if (error instanceof CompanyAccessForbiddenError && error.code === "company_access_required") {
      return null;
    }
    redirectOnAuthRequired(error, "/onboarding");
  }
}

function normalizeNextHref(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  return candidate;
}
