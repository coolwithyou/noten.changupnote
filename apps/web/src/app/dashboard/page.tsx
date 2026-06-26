import { DashboardView } from "@/features/dashboard/DashboardView";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const dashboard = await loadServiceDashboard({ limit: 40 });
  return <DashboardView dashboard={dashboard} />;
}
