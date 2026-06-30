import { DashboardView } from "@/features/dashboard/DashboardView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadNotificationCenter } from "@/lib/server/notifications/notificationCenter";
import { loadOnboardingProgress } from "@/lib/server/onboarding/onboardingProgress";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const access = await loadDashboardAccess();
  const dashboard = await loadServiceDashboard({
    companyId: access.companyId,
    userId: access.userId,
    limit: 40,
    writeMatchStates: false,
  });
  const [notificationFeed, onboardingProgress] = await Promise.all([
    loadNotificationCenter({ access, matches: dashboard.matches }),
    loadOnboardingProgress({ access }),
  ]);
  const user = await getOptionalHeaderUser();
  return (
    <DashboardView
      dashboard={dashboard}
      notificationFeed={notificationFeed}
      onboardingProgress={onboardingProgress}
      user={user}
    />
  );
}

async function loadDashboardAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/dashboard");
  }
}
