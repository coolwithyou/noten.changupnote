import { notFound } from "next/navigation";
import { ApplySheetView } from "@/features/apply-sheet/ApplySheetView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadGrantPreparation } from "@/lib/server/documents/grantPreparation";
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
  const preparation = await loadInitialPreparation(sheet.grant.id, access, sheet);
  const user = (await getOptionalHeaderUser()) ?? fallbackHeaderUserForDemoAccess(access);
  return (
    <ApplySheetView
      sheet={sheet}
      user={user}
      initialDrafts={preparation?.drafts ?? []}
      formFields={preparation?.formFields ?? []}
    />
  );
}

async function loadGrantAccess(grantId: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, `/grants/${encodeURIComponent(grantId)}`);
  }
}

async function loadInitialPreparation(
  grantId: string,
  access: Awaited<ReturnType<typeof loadGrantAccess>>,
  sheet: NonNullable<Awaited<ReturnType<typeof loadServiceApplySheet>>>,
) {
  try {
    return await loadGrantPreparation({ grantId, access, sheet });
  } catch (error) {
    console.warn(`Grant preparation preload failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
