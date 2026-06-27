import { buildStats } from "@cunote/core";
import { HomeExperience } from "@/features/home/HomeExperience";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadServiceGrants } from "@/lib/server/serviceData";

export default async function HomePage() {
  const asOf = new Date();
  const grants = await loadServiceGrants({ asOf, limit: 40 });
  const stats = buildStats({ grants, asOf });
  const user = await getOptionalHeaderUser();
  return <HomeExperience initialStats={stats} user={user} />;
}
