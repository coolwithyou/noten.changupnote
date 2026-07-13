import { redirect } from "next/navigation";
import { OpsDashboardShell } from "@/components/OpsDashboardShell";
import { LiveMatchConsole } from "@/components/LiveMatchConsole";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";

export const dynamic = "force-dynamic";

export default async function InternalLiveMatchPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");

  return (
    <OpsDashboardShell
      title="라이브 매칭"
      user={{ email: session.user.email, name: session.user.name ?? null, role: session.user.role }}
    >
      <LiveMatchConsole />
    </OpsDashboardShell>
  );
}
