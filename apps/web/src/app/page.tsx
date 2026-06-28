import { HomeExperience } from "@/features/home/HomeExperience";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadLandingGrantData } from "@/lib/server/landing/landingGrantData";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const asOf = new Date();
  const landingData = await loadLandingGrantData({ asOf });
  const user = await getOptionalHeaderUser();
  return <HomeExperience landingData={landingData} user={user} />;
}
