import { notFound } from "next/navigation";
import { ApplySheetView } from "@/features/apply-sheet/ApplySheetView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { loadServiceApplySheet } from "@/lib/server/serviceData";

export const dynamic = "force-dynamic";

interface GrantDetailPageProps {
  params: Promise<{
    grantId: string;
  }>;
}

export default async function GrantDetailPage({ params }: GrantDetailPageProps) {
  const { grantId } = await params;
  const access = await requireCompanyAccess();
  const sheet = await loadServiceApplySheet(grantId, { companyId: access.companyId, userId: access.userId });
  if (!sheet) notFound();
  return <ApplySheetView sheet={sheet} />;
}
