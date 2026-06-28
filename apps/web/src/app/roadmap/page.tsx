import { RoadmapView } from "@/features/roadmap/RoadmapView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function RoadmapPage() {
  const access = await loadRoadmapAccess();
  const dashboard = await loadServiceDashboard({
    companyId: access.companyId,
    userId: access.userId,
    limit: 40,
    writeMatchStates: false,
  });
  const user = await getOptionalHeaderUser();
  return <RoadmapView dashboard={dashboard} user={user} />;
}

async function loadRoadmapAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/roadmap");
  }
}
