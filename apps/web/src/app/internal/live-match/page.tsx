import { LiveMatchConsole } from "@/features/live-match/LiveMatchConsole";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

export default async function InternalLiveMatchPage() {
  const user = await getOptionalHeaderUser();
  return <LiveMatchConsole user={user} />;
}
