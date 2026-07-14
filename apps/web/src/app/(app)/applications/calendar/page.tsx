import { ApplicationCalendarView } from "@/features/applications/ApplicationCalendarView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { buildApplicationPipeline } from "@/lib/server/applications/pipeline";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function ApplicationsCalendarPage() {
  const access = await loadCalendarAccess();
  const dashboard = await loadServiceDashboard({
    companyId: access.companyId,
    userId: access.userId,
    limit: 80,
    writeMatchStates: false,
  });
  const pipeline = await buildApplicationPipeline({
    access,
    matches: dashboard.matches,
  });
  return <ApplicationCalendarView pipeline={pipeline} />;
}

async function loadCalendarAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/applications/calendar");
  }
}
