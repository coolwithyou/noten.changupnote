import { buildStats } from "@cunote/core";
import { HomeExperience } from "@/features/home/HomeExperience";
import { loadServiceGrants } from "@/lib/server/serviceData";

export default async function HomePage() {
  const asOf = new Date();
  const grants = await loadServiceGrants({ asOf, limit: 40 });
  const stats = buildStats({ grants, asOf });
  return <HomeExperience initialStats={stats} />;
}
