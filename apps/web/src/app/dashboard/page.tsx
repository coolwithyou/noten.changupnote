import { buildNotificationFeed } from "@cunote/core";
import { DashboardView } from "@/features/dashboard/DashboardView";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const access = await loadDashboardAccess();
  const [dashboard, notificationSettings] = await Promise.all([
    loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 }),
    getAppPreferencesStore().getNotificationSettings(access.userId),
  ]);
  const notificationFeed = buildNotificationFeed({
    matches: dashboard.matches,
    settings: notificationSettings,
  });
  return <DashboardView dashboard={dashboard} notificationFeed={notificationFeed} />;
}

async function loadDashboardAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/dashboard");
  }
}
