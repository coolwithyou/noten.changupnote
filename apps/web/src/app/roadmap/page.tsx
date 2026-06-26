import { RoadmapView } from "@/features/roadmap/RoadmapView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function RoadmapPage() {
  const access = await requireCompanyAccess();
  const dashboard = await loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 });
  return <RoadmapView dashboard={dashboard} />;
}
