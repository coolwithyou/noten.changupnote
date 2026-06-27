import { notFound } from "next/navigation";
import { ApplySheetView } from "@/features/apply-sheet/ApplySheetView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadServiceApplySheet } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

interface GrantDetailPageProps {
  params: Promise<{
    grantId: string;
  }>;
}

export default async function GrantDetailPage({ params }: GrantDetailPageProps) {
  const { grantId } = await params;
  const access = await loadGrantAccess(grantId);
  const sheet = await loadServiceApplySheet(grantId, { companyId: access.companyId, userId: access.userId });
  if (!sheet) notFound();
  const user = await getOptionalHeaderUser();
  return <ApplySheetView sheet={sheet} user={user} />;
}

async function loadGrantAccess(grantId: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, `/grants/${encodeURIComponent(grantId)}`);
  }
}
