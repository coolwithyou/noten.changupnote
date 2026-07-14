import { SettingsPageView } from "@/features/settings/SettingsPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser, getOptionalWebSession } from "@/lib/server/auth/session";
import { listAccountDeletionRequestHistory } from "@/lib/server/account/accountDeletionRequestHistory";
import { loadAccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { normalizeSettingsSection, settingsPath } from "@/lib/navigation/settingsDeepLink";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const initialSection = normalizeSettingsSection(query.section);
  const access = await loadSettingsAccess(settingsPath(initialSection));
  const [user, session, companies, notificationSettings] = await Promise.all([
    getOptionalHeaderUser().then((user) => user ?? fallbackHeaderUserForDemoAccess(access)),
    getOptionalWebSession(),
    getServiceRepositories().companies.listUserCompanies(access.userId),
    getAppPreferencesStore().getNotificationSettings(access.userId),
  ]);
  const [securityStatus, deletionRequests] = await Promise.all([
    loadAccountSecurityStatus({ access, session }),
    listAccountDeletionRequestHistory({ access, session }),
  ]);

  return (
    <SettingsPageView
      access={access}
      user={user}
      currentCompany={companies.find((company) => company.id === access.companyId) ?? null}
      companies={companies}
      notificationSettings={notificationSettings}
      securityStatus={securityStatus}
      deletionRequests={deletionRequests}
      initialSection={initialSection}
    />
  );
}

async function loadSettingsAccess(callbackUrl: string) {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, callbackUrl);
  }
}
