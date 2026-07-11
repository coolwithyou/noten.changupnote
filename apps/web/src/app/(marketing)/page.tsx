import { BizLookupProvider } from "@/features/landing/biz-lookup-context";
import { Faq } from "@/features/landing/faq";
import { FinalCta } from "@/features/landing/final-cta";
import { LandingHero } from "@/features/landing/landing-hero";
import {
  Features,
  HowItWorks,
  LandingFooter,
  SocialProof,
  TrustStats,
} from "@/features/landing/marketing-sections";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { loadLandingGrantData } from "@/lib/server/landing/landingGrantData";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const asOf = new Date();
  const landingData = await loadLandingGrantData({ asOf });
  const user = await getOptionalHeaderUser();

  const activeCount = landingData.stats.activeCount.toLocaleString("ko-KR");
  const sourceCount = landingData.stats.sourceCount;

  return (
    <BizLookupProvider>
      <main className="w-full overflow-x-hidden">
        <LandingHero activeCount={activeCount} user={user} />
        <SocialProof banners={landingData.banners} sourceCount={sourceCount} />
        <HowItWorks />
        <Features />
        <TrustStats activeCount={activeCount} sourceCount={sourceCount} />
        <FinalCta />
        <Faq />
        <LandingFooter />
      </main>
    </BizLookupProvider>
  );
}
