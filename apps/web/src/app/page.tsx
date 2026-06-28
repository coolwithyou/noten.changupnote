import { HomeExperience } from "@/features/home/HomeExperience";
import { loadLandingGrantData } from "@/lib/server/landing/landingGrantData";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const asOf = new Date();
  const landingData = await loadLandingGrantData({ asOf });
  return <HomeExperience landingData={landingData} />;
}
