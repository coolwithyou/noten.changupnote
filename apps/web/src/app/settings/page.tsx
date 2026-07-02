import { SettingsPageView } from "@/features/settings/SettingsPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const access = await loadSettingsAccess();
  const user = (await getOptionalHeaderUser()) ?? fallbackHeaderUserForDemoAccess(access);
  return <SettingsPageView user={user} />;
}

async function loadSettingsAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/settings");
  }
}
