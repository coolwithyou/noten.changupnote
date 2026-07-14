import { PricingPlansView } from "@/features/pricing/PricingPlansView";
import { getOptionalWebSession } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

// /pricing — 요금제 페이지(공개, 디자인 정본 프레임 5a/5b). 상단 헤더는 (marketing) layout의 PublicHeader.
// 공개 라우트이므로 requireWebSession 하지 않고 getOptionalWebSession 으로 로그인 여부만 읽는다.
// 카피는 디자인 정본 고정 카피 — 서버 카탈로그 fetch 없이 정적으로 렌더한다.
export default async function PricingPage() {
  const session = await getOptionalWebSession();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PricingPlansView isLoggedIn={session !== null} />
    </main>
  );
}
