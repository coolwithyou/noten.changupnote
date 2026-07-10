import { AppShell } from "@/components/app/app-shell";
import { TeamPageView } from "@/features/team/TeamPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalWebSession } from "@/lib/server/auth/session";
import { loadWorkspaceOverview } from "@/lib/server/workspace/overview";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const access = await loadTeamAccess();
  const session = await getOptionalWebSession();
  const overview = await loadWorkspaceOverview({ access, session });
  const user = headerUser(session) ?? fallbackHeaderUserForDemoAccess(access);
  return (
    <AppShell user={user}>
      <TeamPageView overview={overview} />
    </AppShell>
  );
}

async function loadTeamAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/team");
  }
}

function headerUser(session: Awaited<ReturnType<typeof getOptionalWebSession>>) {
  if (!session) return null;
  return {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
}
