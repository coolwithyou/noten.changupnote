import { PublicHeader } from "@/components/app/public-header";
import { TeamInviteAcceptView } from "@/features/team/TeamInviteAcceptView";
import { getOptionalWebSession } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

interface TeamInvitePageProps {
  params: Promise<{
    token: string;
  }>;
}

export default async function TeamInvitePage({ params }: TeamInvitePageProps) {
  const [{ token }, session] = await Promise.all([params, getOptionalWebSession()]);
  const callbackUrl = `/team/invite/${encodeURIComponent(token)}`;
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader
        user={session ? { name: session.user.name ?? null, email: session.user.email ?? null } : null}
        links={[
          { href: "/support", label: "고객지원" },
        ]}
        loginCallbackUrl={callbackUrl}
      />
      <TeamInviteAcceptView
        token={token}
        signedIn={Boolean(session)}
        loginHref={`/login?${new URLSearchParams({ callbackUrl }).toString()}`}
      />
    </main>
  );
}
