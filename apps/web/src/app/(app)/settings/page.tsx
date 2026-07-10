import { SettingsPageView } from "@/features/settings/SettingsPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await loadSettingsAccess();
  return <SettingsPageView />;
}

async function loadSettingsAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/settings");
  }
}
