import { MatchesExperience } from "@/features/matches/MatchesExperience";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

export default async function MatchesPage() {
  const user = await getOptionalHeaderUser();
  return <MatchesExperience user={user} />;
}
