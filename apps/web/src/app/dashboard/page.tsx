import { DashboardView } from "@/features/dashboard/DashboardView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const access = await requireCompanyAccess();
  const dashboard = await loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 });
  return <DashboardView dashboard={dashboard} />;
}
