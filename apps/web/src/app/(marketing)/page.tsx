import { BizLookupProvider } from "@/features/landing/biz-lookup-context";
import { Faq } from "@/features/landing/faq";
import { FinalCta } from "@/features/landing/final-cta";
import { LandingHero } from "@/features/landing/landing-hero";
import { GrantMarquee, HowItWorks, LandingFooter } from "@/features/landing/marketing-sections";
import { loadLandingGrantData } from "@/lib/server/landing/landingGrantData";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const asOf = new Date();
  const landingData = await loadLandingGrantData({ asOf });

  return (
    <BizLookupProvider>
      <main className="w-full overflow-x-hidden">
        <LandingHero
          openCount={landingData.stats.openCount}
          comparisonCount={landingData.stats.activeCount}
        />
        <GrantMarquee banners={landingData.banners} />
        <HowItWorks />
        <FinalCta />
        <Faq />
        <LandingFooter />
      </main>
    </BizLookupProvider>
  );
}
