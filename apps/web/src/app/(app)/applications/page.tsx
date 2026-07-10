import { ApplicationPipelineView } from "@/features/applications/ApplicationPipelineView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { buildApplicationPipeline } from "@/lib/server/applications/pipeline";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const access = await loadApplicationsAccess();
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
  return <ApplicationPipelineView pipeline={pipeline} />;
}

async function loadApplicationsAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/applications");
  }
}
