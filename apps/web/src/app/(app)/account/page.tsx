import { AccountPageView } from "@/features/account/AccountPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalHeaderUser, getOptionalWebSession } from "@/lib/server/auth/session";
import { listAccountDeletionRequestHistory } from "@/lib/server/account/accountDeletionRequestHistory";
import { loadAccountSecurityStatus } from "@/lib/server/account/accountSecurityStatus";
import { loadNotificationCenter } from "@/lib/server/notifications/notificationCenter";
import { listAccountSupportTickets } from "@/lib/server/support/supportTicketMessages";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const access = await loadAccountAccess();
  const [user, session] = await Promise.all([
    getOptionalHeaderUser().then((user) => user ?? fallbackHeaderUserForDemoAccess(access)),
    getOptionalWebSession(),
  ]);
  const [supportTickets, deletionRequests, notificationCenter, securityStatus] = await Promise.all([
    listAccountSupportTickets({ access, session }),
    listAccountDeletionRequestHistory({ access, session }),
    loadNotificationCenter({ access, limit: 6 }),
    loadAccountSecurityStatus({ access, session }),
  ]);
  return (
    <AccountPageView
      access={access}
      user={user}
      securityStatus={securityStatus}
      supportTickets={supportTickets}
      deletionRequests={deletionRequests}
      notificationCenter={notificationCenter}
    />
  );
}

async function loadAccountAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/account");
  }
}
